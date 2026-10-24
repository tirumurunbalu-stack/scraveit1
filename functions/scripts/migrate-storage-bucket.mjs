#!/usr/bin/env node
/**
 * Moves Storage objects from the old US bucket to the Mumbai one and points
 * every saved link at the new bucket.
 *
 *   node scripts/migrate-storage-bucket.mjs            # dry run: counts only
 *   node scripts/migrate-storage-bucket.mjs --apply    # copy + rewrite
 *   node scripts/migrate-storage-bucket.mjs --apply --copy-only
 *
 * Safe to run again (it is how anything an older app build uploaded to the
 * old bucket gets moved later): an object already copied with the same bytes
 * is skipped, and a link already on the new bucket is left alone. The old
 * bucket is never changed or emptied.
 *
 * Copies keep their metadata, including firebaseStorageDownloadTokens, so a
 * link only needs its bucket name swapped to keep working. Uses Application
 * Default Credentials (gcloud auth application-default login).
 */
import {initializeApp, applicationDefault} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";

const PROJECT = "savrivo-app";
const OLD = "savrivo-app.firebasestorage.app";
const NEW = "savrivo-app-mumbai";
const apply = process.argv.includes("--apply");
const copyOnly = process.argv.includes("--copy-only");

const app = initializeApp({credential: applicationDefault(), projectId: PROJECT});
const db = getFirestore(app);
const storage = getStorage(app);

async function copyObjects() {
  const [files] = await storage.bucket(OLD).getFiles();
  let copied = 0, skipped = 0;
  for (const file of files) {
    const target = storage.bucket(NEW).file(file.name);
    const [exists] = await target.exists();
    if (exists) {
      const [[a], [b]] = await Promise.all([file.getMetadata(), target.getMetadata()]);
      if (a.md5Hash === b.md5Hash) { skipped++; continue; }
    }
    if (apply) await file.copy(target);
    copied++;
  }
  console.log(`objects: ${files.length} in old bucket, ${copied} ${apply ? "copied" : "to copy"}, ${skipped} already there`);
}

// Every way a link can name the old bucket.
const PATTERNS = [
  [`/v0/b/${OLD}/o/`, `/v0/b/${NEW}/o/`],
  [`/v0/b/${encodeURIComponent(OLD)}/o/`, `/v0/b/${NEW}/o/`],
  [`storage.googleapis.com/${OLD}/`, `storage.googleapis.com/${NEW}/`],
  [`gs://${OLD}/`, `gs://${NEW}/`],
];
function rewrite(value) {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of PATTERNS) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
  }
  return value; // Timestamps, GeoPoints, references, bytes stay as they are.
}

// Runs fn over items, at most `limit` at a time.
async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) { const item = items[next++]; await fn(item); }
  }));
}

// Reads a whole collection in pages (one round trip per 500 documents), then
// looks for subcollections under each document, many at a time.
async function rewriteCollection(ref, counts, depth = 0) {
  let last = null;
  const docs = [];
  for (;;) {
    let query = ref.orderBy("__name__").limit(500);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    docs.push(...page.docs);
    if (page.size < 500) break;
    last = page.docs[page.docs.length - 1];
  }
  counts.docs += docs.length;
  for (const snap of docs) {
    const data = snap.data();
    const next = rewrite(data);
    if (JSON.stringify(next) !== JSON.stringify(data)) {
      counts.changed.push(snap.ref.path);
      if (apply) await snap.ref.set(next);
    }
  }
  // Documents that only hold subcollections don't come back from a query.
  const refs = await ref.listDocuments();
  await pool(refs, 64, async (doc) => {
    for (const sub of await doc.listCollections()) await rewriteCollection(sub, counts, depth + 1);
  });
  if (depth === 0) console.log(`  ${ref.id}: done (${counts.docs} documents so far)`);
}

async function rewriteLinks() {
  const counts = {docs: 0, changed: []};
  for (const collection of await db.listCollections()) await rewriteCollection(collection, counts);
  console.log(`firestore: ${counts.docs} documents read, ${counts.changed.length} ${apply ? "rewritten" : "to rewrite"}`);
  for (const path of counts.changed) console.log("  " + path);
}

console.log(apply ? "APPLY" : "DRY RUN (add --apply to make changes)");
await copyObjects();
if (!copyOnly) await rewriteLinks();
