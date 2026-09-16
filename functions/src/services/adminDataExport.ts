import {randomUUID} from "crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {auth, db, storage} from "../admin";
import {ROOT} from "../config";
import {
  adminAccountExportRows,
  buildPlatformDataWorkbookBuffer,
  customerExportRows,
  filterRowsByCity,
  restaurantExportRows,
  riderExportRows,
  type AdminAuthAccount,
} from "../domain/adminDataExport";
import {requireOwnerClaim} from "./authz";

// A defensive ceiling only - a runaway account count should fail loudly
// rather than let this scan run unbounded.
const MAX_AUTH_ACCOUNTS_SCANNED = 50_000;
// The download link stays reachable until the underlying file is purged, not
// on its own timer - see purgeExpiredPlatformDataExports below.
const EXPORT_RETENTION_MS = 2 * 60 * 60_000;
const EXPORT_STORAGE_PREFIX = "admin-exports/";
const WORKBOOK_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface PlatformDataExportResult {
  downloadUrl: string;
  fileName: string;
  sizeBytes: number;
  generatedAt: number;
  retentionMinutes: number;
  cityFilter: string;
  counts: {
    customers: number;
    riders: number;
    restaurants: number;
    adminAccounts: number;
  };
}

async function listAdminAuthAccounts(): Promise<AdminAuthAccount[]> {
  const matches: AdminAuthAccount[] = [];
  let pageToken: string | undefined;
  let scanned = 0;
  do {
    const page = await auth.listUsers(1000, pageToken);
    scanned += page.users.length;
    for (const user of page.users) {
      const role = user.customClaims?.savrivoRole;
      if (role !== "owner" && role !== "ops_admin") continue;
      matches.push({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        disabled: user.disabled,
        customClaims: user.customClaims,
        metadata: {
          creationTime: user.metadata.creationTime,
          lastSignInTime: user.metadata.lastSignInTime,
        },
      });
    }
    pageToken = page.pageToken;
  } while (pageToken && scanned < MAX_AUTH_ACCOUNTS_SCANNED);
  return matches;
}

function fileNameStamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/** Turns "Naidupeta " into "naidupeta" for a filename; empty for no filter. */
function citySlug(city: string): string {
  return city.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export async function exportPlatformDataWorkbook(
  token: DecodedIdToken,
  city?: string,
): Promise<PlatformDataExportResult> {
  requireOwnerClaim(token);
  const uid = token.uid;
  const cityFilter = String(city ?? "").trim().slice(0, 120);

  const [usersSnapshot, ridersSnapshot, restaurantsSnapshot, adminAuthAccounts] = await Promise.all([
    db.ref(`${ROOT}/users`).get(),
    db.ref(`${ROOT}/riders`).get(),
    db.ref(`${ROOT}/catalog/restaurants`).get(),
    listAdminAuthAccounts(),
  ]);

  const customers = filterRowsByCity(customerExportRows(usersSnapshot.val()), cityFilter);
  const riders = filterRowsByCity(riderExportRows(ridersSnapshot.val()), cityFilter);
  const restaurants = filterRowsByCity(restaurantExportRows(restaurantsSnapshot.val()), cityFilter);
  // Admin/ops-admin accounts are platform-wide, not tied to a city - a city
  // filter narrows the other three sheets only, never this one.
  const adminAccounts = adminAccountExportRows(adminAuthAccounts);
  const generatedAt = Date.now();

  const buffer = await buildPlatformDataWorkbookBuffer({
    generatedAt,
    generatedByEmail: String(token.email ?? ""),
    cityFilter,
    customers,
    riders,
    restaurants,
    adminAccounts,
  });

  const citySuffix = citySlug(cityFilter);
  const fileName = `savrivo-platform-data-${citySuffix ? citySuffix + "-" : ""}${fileNameStamp(generatedAt)}.xlsx`;
  const objectPath = `${EXPORT_STORAGE_PREFIX}${uid}/${fileName}`;
  const bucket = storage.bucket();
  const file = bucket.file(objectPath);
  // A Firebase download token is the access control for this URL - it works
  // the same way client-side getDownloadURL() does, and needs no extra IAM
  // grant the way a GCS-signed URL would (signBlob is not guaranteed to be
  // available to every Cloud Functions service account).
  const downloadToken = randomUUID();
  await file.save(buffer, {
    contentType: WORKBOOK_CONTENT_TYPE,
    metadata: {
      cacheControl: "private, max-age=0, no-store",
      contentDisposition: `attachment; filename="${fileName}"`,
      metadata: {firebaseStorageDownloadTokens: downloadToken},
    },
  });
  const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}`
    + `/o/${encodeURIComponent(objectPath)}?alt=media&token=${downloadToken}`;

  const auditId = `admin-data-export-${uid}-${generatedAt}`;
  const auditRecord = {
    id: auditId,
    action: "admin_data_export.generate",
    target: "platformDataExport",
    detail: `city=${cityFilter || "all"}, customers=${customers.length}, riders=${riders.length}, `
      + `restaurants=${restaurants.length}, adminAccounts=${adminAccounts.length}`,
    actorId: uid,
    actorEmail: String(token.email ?? "").slice(0, 254),
    actorRole: "owner",
    at: generatedAt,
  };
  db.ref(`${ROOT}/audit/${auditId}`).set(auditRecord).catch((error) => {
    logger.warn("admin data export audit write failed", {uid, error});
  });

  return {
    downloadUrl,
    fileName,
    sizeBytes: buffer.length,
    generatedAt,
    retentionMinutes: Math.round(EXPORT_RETENTION_MS / 60_000),
    cityFilter,
    counts: {
      customers: customers.length,
      riders: riders.length,
      restaurants: restaurants.length,
      adminAccounts: adminAccounts.length,
    },
  };
}

/**
 * Run on a schedule (see index.ts) rather than after each export: the file
 * has to keep existing until the admin's device has actually finished
 * downloading it, so nothing here can delete it eagerly. This is the only
 * thing bounding how long a copy of everyone's data sits in Storage.
 */
export async function purgeExpiredPlatformDataExports(now = Date.now()): Promise<number> {
  const [files] = await storage.bucket().getFiles({prefix: EXPORT_STORAGE_PREFIX});
  let deleted = 0;
  for (const file of files) {
    const createdRaw = file.metadata?.timeCreated;
    const createdAt = createdRaw ? Date.parse(createdRaw) : NaN;
    if (!Number.isFinite(createdAt) || now - createdAt < EXPORT_RETENTION_MS) continue;
    try {
      await file.delete({ignoreNotFound: true});
      deleted++;
    } catch (error) {
      logger.warn("failed to purge an expired admin data export", {file: file.name, error});
    }
  }
  return deleted;
}
