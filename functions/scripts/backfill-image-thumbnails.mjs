#!/usr/bin/env node

/**
 * One-time backfill: generate the small `imageThumbUrl` companion image for
 * every restaurant cover photo and menu item photo that was uploaded before
 * the customer app started preferring a thumbnail over the full-size image.
 *
 * Dry-run by default. Nothing is downloaded, resized, uploaded or written to
 * the database unless --apply is passed, mirroring
 * functions/scripts/backfill-operational-projections.mjs's safety pattern.
 *
 * Required environment:
 *   SAVRIVO_EXPECTED_PROJECT_ID=<exact Firebase project id>
 *   SAVRIVO_DATABASE_URL=<exact Realtime Database URL>
 *   SAVRIVO_STORAGE_BUCKET=<exact Storage bucket, e.g. savrivo-app.firebasestorage.app>
 *
 * Apply additionally requires:
 *   SAVRIVO_CONFIRM_PROJECT_ID=<same exact project id>
 *
 * Usage:
 *   node functions/scripts/backfill-image-thumbnails.mjs                # dry run
 *   node functions/scripts/backfill-image-thumbnails.mjs --apply        # writes
 */

import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {getDatabase} from "firebase-admin/database";
import {getStorage} from "firebase-admin/storage";
import Jimp from "jimp";

const ROOT = "feastly";
const THUMB_MAX_EDGE = 480;
const THUMB_QUALITY = 72;
const DEFAULT_MAX_RECORDS = 500;

function positiveInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function parseOptions(argv) {
  const options = {apply: false, maxRecords: DEFAULT_MAX_RECORDS};
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg.startsWith("--max-records=")) {
      options.maxRecords = positiveInteger(arg.slice("--max-records=".length), "max-records", 1, 10000);
    } else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Backfill imageThumbUrl for restaurant covers and menu items (dry-run by default).",
    "",
    "Required environment:",
    "  SAVRIVO_EXPECTED_PROJECT_ID=<exact Firebase project id>",
    "  SAVRIVO_DATABASE_URL=<exact Realtime Database URL>",
    "  SAVRIVO_STORAGE_BUCKET=<exact Storage bucket>",
    "",
    "Apply additionally requires:",
    "  SAVRIVO_CONFIRM_PROJECT_ID=<same exact project id>",
    "",
    "Options:",
    "  --apply                enable Storage/database writes",
    "  --max-records=500      image records processed this run (1..10000)",
  ].join("\n");
}

/** Mirrors the client's storageObjectName()/thumbPath() so URLs stay identical in shape. */
export function objectPathFromDownloadUrl(url, expectedBucket) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "firebasestorage.googleapis.com") return "";
  const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
  if (!match) return "";
  if (decodeURIComponent(match[1]) !== expectedBucket) return "";
  return decodeURIComponent(match[2]);
}

export function thumbObjectPath(objectPath) {
  return objectPath.replace(/\.jpg$/i, "-thumb.jpg");
}

export function downloadUrlFor(bucket, objectPath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/`
    + `${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(token)}`;
}

async function buildThumbBuffer(sourceBuffer) {
  const image = await Jimp.read(sourceBuffer);
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  image.resize(targetWidth, targetHeight);
  image.quality(THUMB_QUALITY);
  return image.getBufferAsync(Jimp.MIME_JPEG);
}

async function backfillImage(bucket, storageBucketName, sourceUrl, counters, label) {
  const objectPath = objectPathFromDownloadUrl(sourceUrl, storageBucketName);
  if (!objectPath) {
    counters.skippedUnrecognizedUrl += 1;
    console.log(`SKIP ${label}: imageUrl is not a recognized Storage download URL for this bucket.`);
    return null;
  }
  const thumbPath = thumbObjectPath(objectPath);
  if (thumbPath === objectPath) {
    counters.skippedUnrecognizedUrl += 1;
    console.log(`SKIP ${label}: object path does not end in .jpg, cannot derive a thumb path.`);
    return null;
  }
  try {
    const [sourceBuffer] = await bucket.file(objectPath).download();
    const thumbBuffer = await buildThumbBuffer(sourceBuffer);
    const token = randomUUID();
    counters.bytesBefore += sourceBuffer.length;
    counters.bytesAfter += thumbBuffer.length;
    counters.processed += 1;
    console.log(`OK ${label}: ${sourceBuffer.length}B -> ${thumbBuffer.length}B`);
    return {thumbPath, thumbBuffer, token};
  } catch (error) {
    counters.failed += 1;
    console.log(`FAIL ${label}: ${String(error?.message ?? error)}`);
    return null;
  }
}

async function writeThumb(bucket, storageBucketName, thumbPath, thumbBuffer, token, apply) {
  if (!apply) return downloadUrlFor(storageBucketName, thumbPath, token);
  await bucket.file(thumbPath).save(thumbBuffer, {
    contentType: "image/jpeg",
    metadata: {
      cacheControl: "public, max-age=31536000, immutable",
      metadata: {firebaseStorageDownloadTokens: token},
    },
  });
  return downloadUrlFor(storageBucketName, thumbPath, token);
}

async function backfillRestaurants(database, bucket, storageBucketName, options, counters, budget) {
  const snapshot = await database.ref(`${ROOT}/catalog/restaurants`).get();
  const restaurants = snapshot.val() || {};
  for (const [restaurantId, restaurant] of Object.entries(restaurants)) {
    if (budget.remaining <= 0) return;
    if (!restaurant || typeof restaurant !== "object") continue;
    const imageUrl = String(restaurant.imageUrl || "");
    if (!imageUrl) { counters.skippedNoImage += 1; continue; }
    if (restaurant.imageThumbUrl) { counters.skippedAlreadyThumbed += 1; continue; }
    budget.remaining -= 1;
    const result = await backfillImage(bucket, storageBucketName, imageUrl, counters, `restaurant/${restaurantId}`);
    if (!result) continue;
    const thumbUrl = await writeThumb(bucket, storageBucketName, result.thumbPath, result.thumbBuffer, result.token, options.apply);
    if (options.apply) {
      await database.ref(`${ROOT}/catalog/restaurants/${restaurantId}/imageThumbUrl`).set(thumbUrl);
      counters.writesCommitted += 1;
    } else {
      counters.writesPlanned += 1;
    }
  }
}

async function backfillMenuItems(database, bucket, storageBucketName, options, counters, budget) {
  const restaurantsSnapshot = await database.ref(`${ROOT}/menus`).get();
  const restaurantMenus = restaurantsSnapshot.val() || {};
  for (const [restaurantId, menu] of Object.entries(restaurantMenus)) {
    if (budget.remaining <= 0) return;
    if (!menu || typeof menu !== "object") continue;
    for (const [itemId, item] of Object.entries(menu)) {
      if (budget.remaining <= 0) return;
      if (!item || typeof item !== "object") continue;
      const imageUrl = String(item.imageUrl || "");
      if (!imageUrl) { counters.skippedNoImage += 1; continue; }
      if (item.imageThumbUrl) { counters.skippedAlreadyThumbed += 1; continue; }
      budget.remaining -= 1;
      const label = `menuItem/${restaurantId}/${itemId}`;
      const result = await backfillImage(bucket, storageBucketName, imageUrl, counters, label);
      if (!result) continue;
      const thumbUrl = await writeThumb(bucket, storageBucketName, result.thumbPath, result.thumbBuffer, result.token, options.apply);
      if (options.apply) {
        await database.ref(`${ROOT}/menus/${restaurantId}/${itemId}/imageThumbUrl`).set(thumbUrl);
        counters.writesCommitted += 1;
      } else {
        counters.writesPlanned += 1;
      }
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const apply = options.apply === true;
  const expectedProjectId = String(process.env.SAVRIVO_EXPECTED_PROJECT_ID ?? "").trim();
  const confirmationProjectId = String(process.env.SAVRIVO_CONFIRM_PROJECT_ID ?? "").trim();
  const databaseUrl = String(process.env.SAVRIVO_DATABASE_URL ?? "").trim().replace(/\/$/u, "");
  const storageBucketName = String(process.env.SAVRIVO_STORAGE_BUCKET ?? "").trim();
  if (!expectedProjectId) throw new Error("SAVRIVO_EXPECTED_PROJECT_ID is required.");
  if (!databaseUrl || !/^https:\/\/[^/]+(?:\.firebaseio\.com|\.firebasedatabase\.app)$/u.test(databaseUrl)) {
    throw new Error("SAVRIVO_DATABASE_URL must be the exact HTTPS Firebase Realtime Database root URL.");
  }
  if (!storageBucketName) throw new Error("SAVRIVO_STORAGE_BUCKET is required.");
  const databaseHost = new URL(databaseUrl).hostname;
  const databaseInstance = databaseHost.split(".")[0];
  if (databaseInstance !== expectedProjectId && !databaseInstance.startsWith(`${expectedProjectId}-`)) {
    throw new Error("SAVRIVO_DATABASE_URL does not belong to SAVRIVO_EXPECTED_PROJECT_ID.");
  }
  if (apply && confirmationProjectId !== expectedProjectId) {
    throw new Error("Apply requires SAVRIVO_CONFIRM_PROJECT_ID to exactly match SAVRIVO_EXPECTED_PROJECT_ID.");
  }

  const app = initializeApp({
    credential: applicationDefault(),
    projectId: expectedProjectId,
    databaseURL: databaseUrl,
    storageBucket: storageBucketName,
  }, `image-thumbnail-backfill-${Date.now()}`);
  const database = getDatabase(app);
  const bucket = getStorage(app).bucket();
  const counters = {
    processed: 0,
    failed: 0,
    skippedNoImage: 0,
    skippedAlreadyThumbed: 0,
    skippedUnrecognizedUrl: 0,
    writesCommitted: 0,
    writesPlanned: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };
  const budget = {remaining: options.maxRecords};

  try {
    console.log(`${apply ? "APPLY" : "DRY RUN"}: project=${expectedProjectId}, boundedRecords=${options.maxRecords}`);
    await backfillRestaurants(database, bucket, storageBucketName, options, counters, budget);
    await backfillMenuItems(database, bucket, storageBucketName, options, counters, budget);
    console.log([
      `SUMMARY mode=${apply ? "apply" : "dry-run"}`,
      `processed=${counters.processed}`,
      `failed=${counters.failed}`,
      `skippedNoImage=${counters.skippedNoImage}`,
      `skippedAlreadyThumbed=${counters.skippedAlreadyThumbed}`,
      `skippedUnrecognizedUrl=${counters.skippedUnrecognizedUrl}`,
      `writesCommitted=${counters.writesCommitted}`,
      `writesPlanned=${counters.writesPlanned}`,
      `bytesBefore=${counters.bytesBefore}`,
      `bytesAfter=${counters.bytesAfter}`,
    ].join(" "));
    if (!apply) console.log("No Storage uploads or database writes were performed. Review the dry run before applying.");
    else console.log("Backfill complete. Re-run any time; already-thumbed records are skipped automatically.");
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = String(error?.message ?? "");
    const code = message.includes("permission") || message.includes("PERMISSION")
      ? "PERMISSION_DENIED"
      : message.includes("credential") || message.includes("Credential")
        ? "CREDENTIALS_UNAVAILABLE"
        : "OPERATION_FAILED";
    console.error(`BACKFILL_FAILED code=${code}`);
    process.exitCode = 1;
  });
}
