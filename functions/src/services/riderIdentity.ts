import {createHash} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {encode as encodeJpeg} from "jpeg-js";
import {JpxImage} from "jpeg2000";
import {firestoreDb, storage} from "../admin";
import {aadhaarHolderKey, ageOn, assessPan, normalizeName, panKey, parseSecureQr, SecureQrError, uidaiSigner} from "../domain/aadhaarSecureQr";
import {DomainError} from "../errors";
import {faceSimilarity} from "./faceVerification";

/**
 * Rider identity, the low-cost and lawful way:
 *
 *  - Aadhaar: the rider scans the UIDAI-signed Secure QR on their own Aadhaar
 *    (card, letter, e-Aadhaar or masked Aadhaar). We check UIDAI's signature,
 *    so the details are proven genuine, and we never see or keep the Aadhaar
 *    number - only its last 4 digits. No Aadhaar photocopies are collected.
 *  - Face: the live selfie (existing face check) is compared with the photo
 *    inside the QR, so the card belongs to the person signing up.
 *  - PAN: offline checks (format, individual PAN, surname letter against the
 *    Aadhaar name, not used by another rider) plus a PAN card photo for the
 *    admin. A paid PAN-registry check is added when TDS goes live.
 *  - Retention: the Aadhaar photo and any old Aadhaar images are deleted 7 days
 *    after the rider is approved or rejected; the result stays.
 *
 * Note for launch: offline Aadhaar verification needs Scraveit registered with
 * UIDAI as an Offline Verification Seeking Entity (free) under the Aadhaar
 * (Authentication and Offline Verification) Regulations, as amended in 2025.
 */

const FACE_MATCH_OK = 85;
const FACE_MATCH_LOW = 60;
const MAX_ATTEMPTS_PER_DAY = 12;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const IDENTITY_CONSENT_VERSION = "rider-identity-v3";

const riders = () => firestoreDb.collection("riders");
const identityDoc = (uid: string) => firestoreDb.collection("private").doc("riderIdentity").collection("riders").doc(uid);
const aadhaarHolderDoc = (key: string) => firestoreDb.collection("private").doc("riderIdentity").collection("aadhaarHolders").doc(key);
const panHolderDoc = (key: string) => firestoreDb.collection("private").doc("riderIdentity").collection("panHolders").doc(key);
const attemptsDoc = (uid: string, day: string) => firestoreDb.collection("private").doc("riderIdentity").collection("attempts").doc(`${uid}_${day}`);
const aadhaarPhotoPath = (uid: string) => `private/rider-identity/${uid}/aadhaar-photo.jpg`;

/** The QR photo (JPEG 2000, ~60px) as a 240px JPEG for face matching and the admin. */
export async function aadhaarPhotoToJpeg(jp2: Buffer): Promise<Buffer> {
  const image = new JpxImage();
  image.parse(jp2);
  const width = image.width; const height = image.height; const components = image.componentsCount;
  const tile = image.tiles[0];
  if (!tile) throw new Error("JPX_NO_TILE");
  const items = tile.items;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const r = (components >= 3 ? items[i * components] : items[i]) ?? 0;
    const g = (components >= 3 ? items[i * components + 1] : items[i]) ?? 0;
    const b = (components >= 3 ? items[i * components + 2] : items[i]) ?? 0;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  // Bilinear upscale to about 240px so face matching has enough pixels.
  const scale = Math.max(1, Math.round(240 / Math.max(width, height)));
  const outW = width * scale; const outH = height * scale;
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, (y + 0.5) / scale - 0.5); const y0 = Math.max(0, Math.floor(sy)); const y1 = Math.min(height - 1, y0 + 1); const fy = Math.max(0, sy - y0);
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, (x + 0.5) / scale - 0.5); const x0 = Math.max(0, Math.floor(sx)); const x1 = Math.min(width - 1, x0 + 1); const fx = Math.max(0, sx - x0);
      for (let c = 0; c < 4; c++) {
        const p = (yy: number, xx: number) => rgba[(yy * width + xx) * 4 + c] ?? 0;
        const top = p(y0, x0) * (1 - fx) + p(y0, x1) * fx;
        const bottom = p(y1, x0) * (1 - fx) + p(y1, x1) * fx;
        out[(y * outW + x) * 4 + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return Buffer.from(encodeJpeg({data: out, width: outW, height: outH}, 92).data);
}

async function readObject(path: string): Promise<Buffer | null> {
  try {
    const [buffer] = await storage.bucket().file(path).download();
    return buffer;
  } catch {
    return null;
  }
}

async function takeAttempt(uid: string, now: number): Promise<void> {
  const day = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
  const ok = await firestoreDb.runTransaction(async (transaction) => {
    const ref = attemptsDoc(uid, day);
    const snapshot = await transaction.get(ref);
    const count = snapshot.exists ? Number((snapshot.data() as Record<string, unknown>).count) || 0 : 0;
    if (count >= MAX_ATTEMPTS_PER_DAY) return false;
    transaction.set(ref, {uid, day, count: count + 1, updatedAt: now});
    return true;
  });
  if (!ok) throw new DomainError("resource-exhausted", "Too many tries today. Try again tomorrow, or contact support.");
}

export interface RiderIdentitySummary {
  status: "verified" | "review" | "pending";
  aadhaar: {verified: boolean; method: string; last4: string; name: string; gender: string; birthYear: number;
    district: string; state: string; keyId: string; issuedAt: number; verifiedAt: number} | null;
  face: {status: "match" | "low" | "mismatch" | "pending" | "unavailable"; similarity: number};
  pan: {formatOk: boolean; individual: boolean; nameInitialMatch: boolean | null; duplicateOf: string} | null;
  duplicateAadhaarOf: string;
  reasons: string[];
  updatedAt: number;
}

function faceStatus(similarity: number | undefined): RiderIdentitySummary["face"] {
  if (similarity === undefined || similarity === null) return {status: "pending", similarity: 0};
  if (similarity < 0) return {status: "unavailable", similarity: 0};
  if (similarity >= FACE_MATCH_OK) return {status: "match", similarity: Math.round(similarity)};
  if (similarity >= FACE_MATCH_LOW) return {status: "low", similarity: Math.round(similarity)};
  return {status: "mismatch", similarity: Math.round(similarity)};
}

/** Everything an admin needs at a glance, recomputed whenever a source field changes. */
export function summarizeIdentity(rider: Record<string, unknown>, identity: Record<string, unknown> | null, now: number): RiderIdentitySummary {
  const aadhaar = identity && identity.aadhaar ? identity.aadhaar as Record<string, unknown> : null;
  const face = faceStatus(identity && typeof identity.faceSimilarity === "number" &&
    identity.faceComparedFor === rider.faceReferenceObjectPath ? identity.faceSimilarity as number : undefined);
  const panNumber = String(rider.panNumber || "");
  const pan = panNumber ? {...assessPan(panNumber, aadhaar ? String(aadhaar.name) : undefined), duplicateOf: String(identity?.panDuplicateOf || "")} : null;
  const duplicateAadhaarOf = String(identity?.aadhaarDuplicateOf || "");
  const reasons: string[] = [];
  if (!aadhaar) reasons.push(rider.identityFallback === "manual" ? "Aadhaar was uploaded for manual review (no QR)" : "Aadhaar not verified yet");
  if (duplicateAadhaarOf) reasons.push("This Aadhaar is already used by another rider account");
  if (aadhaar && face.status === "pending") reasons.push("Face scan not compared with the Aadhaar photo yet");
  if (face.status === "low") reasons.push(`Face only partly matches the Aadhaar photo (${face.similarity}%)`);
  if (face.status === "mismatch") reasons.push(`Face doesn’t match the Aadhaar photo (${face.similarity}%)`);
  if (face.status === "unavailable") reasons.push("Face comparison failed, compare the photos by eye");
  if (!pan) reasons.push("PAN not given");
  else {
    if (!pan.formatOk) reasons.push("PAN format is wrong");
    else if (!pan.individual) reasons.push("PAN isn’t an individual’s PAN (4th letter should be P)");
    if (pan.nameInitialMatch === false) reasons.push("PAN 5th letter doesn’t match any initial of the Aadhaar name");
    if (pan.duplicateOf) reasons.push("This PAN is already used by another rider account");
  }
  const status = !aadhaar ? "pending" : reasons.length ? "review" : "verified";
  return {
    status,
    aadhaar: aadhaar ? {verified: true, method: "uidai_secure_qr", last4: String(aadhaar.last4), name: String(aadhaar.name),
      gender: String(aadhaar.gender), birthYear: Number(String(aadhaar.dob).slice(0, 4)), district: String((aadhaar.address as Record<string, string>)?.district || ""),
      state: String((aadhaar.address as Record<string, string>)?.state || ""), keyId: String(aadhaar.keyId), issuedAt: Number(aadhaar.issuedAt) || 0,
      verifiedAt: Number(aadhaar.verifiedAt) || 0} : null,
    face, pan, duplicateAadhaarOf, reasons, updatedAt: now,
  };
}

async function compareFaceIfReady(uid: string, rider: Record<string, unknown>, identity: Record<string, unknown> | null,
  aws: {id: string; secret: string}): Promise<Record<string, unknown> | null> {
  const reference = String(rider.faceReferenceObjectPath || "");
  if (!identity || !identity.photoPath || !reference || identity.faceComparedFor === reference) return identity;
  const [aadhaarPhoto, selfie] = await Promise.all([readObject(String(identity.photoPath)), readObject(reference)]);
  if (!aadhaarPhoto || !selfie) return identity;
  const similarity = await faceSimilarity(aws.id, aws.secret, aadhaarPhoto, selfie);
  const update = {faceSimilarity: similarity, faceComparedFor: reference, faceComparedAt: Date.now()};
  await identityDoc(uid).set(update, {merge: true});
  return {...identity, ...update};
}

async function claimPan(uid: string, panNumber: string): Promise<string> {
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber)) return "";
  const ref = panHolderDoc(panKey(panNumber));
  return firestoreDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const holder = snapshot.exists ? String((snapshot.data() as Record<string, unknown>).uid || "") : "";
    if (holder && holder !== uid) return holder;
    if (!holder) transaction.set(ref, {uid, at: Date.now()});
    return "";
  });
}

/** Re-derive the rider's identity summary (called after any source change). */
export async function refreshRiderIdentity(uid: string, aws: {id: string; secret: string}, now = Date.now()): Promise<RiderIdentitySummary | null> {
  const riderSnap = await riders().doc(uid).get();
  if (!riderSnap.exists) return null;
  const rider = riderSnap.data() as Record<string, unknown>;
  let identity = (await identityDoc(uid).get()).data() as Record<string, unknown> | undefined ?? null;
  identity = await compareFaceIfReady(uid, rider, identity, aws);
  const panNumber = String(rider.panNumber || "").toUpperCase();
  if (panNumber && identity?.panCheckedFor !== panNumber) {
    const duplicateOf = await claimPan(uid, panNumber);
    const update = {panCheckedFor: panNumber, panDuplicateOf: duplicateOf};
    await identityDoc(uid).set(update, {merge: true});
    identity = {...(identity ?? {}), ...update};
  }
  const summary = summarizeIdentity(rider, identity, now);
  const previous = JSON.stringify({...(rider.identity as object || {}), updatedAt: 0});
  if (previous !== JSON.stringify({...summary, updatedAt: 0})) await riders().doc(uid).set({identity: summary}, {merge: true});
  return summary;
}

/** The rider scanned (or uploaded) their Aadhaar Secure QR. */
export async function verifyRiderAadhaarQr(uid: string, input: {qrData: string; consentVersion: string}, aws: {id: string; secret: string}, now = Date.now()) {
  if (input.consentVersion !== IDENTITY_CONSENT_VERSION) throw new DomainError("failed-precondition", "Please accept the identity consent first.");
  await takeAttempt(uid, now);
  let qr;
  try {
    qr = parseSecureQr(input.qrData);
  } catch (error) {
    if (error instanceof SecureQrError) throw new DomainError("invalid-argument", error.message);
    throw error;
  }
  const keyId = uidaiSigner(qr);
  if (!keyId) {
    logger.warn("AADHAAR_QR_SIGNATURE_INVALID", {uid, version: qr.version});
    throw new DomainError("invalid-argument", "We couldn’t confirm this QR with UIDAI. Scan the QR on your original Aadhaar, or download a fresh e-Aadhaar from myaadhaar.uidai.gov.in.");
  }
  const age = ageOn(qr.dob, now);
  if (age < 18) throw new DomainError("failed-precondition", "Delivery partners must be 18 or older.");

  const holderKey = aadhaarHolderKey(qr);
  const duplicateOf = await firestoreDb.runTransaction(async (transaction) => {
    const ref = aadhaarHolderDoc(holderKey);
    const snapshot = await transaction.get(ref);
    const holder = snapshot.exists ? String((snapshot.data() as Record<string, unknown>).uid || "") : "";
    if (holder && holder !== uid) return holder;
    if (!holder) transaction.set(ref, {uid, at: now});
    return "";
  });

  let photoPath = "";
  try {
    const jpeg = await aadhaarPhotoToJpeg(qr.photo);
    photoPath = aadhaarPhotoPath(uid);
    await storage.bucket().file(photoPath).save(jpeg, {resumable: false, contentType: "image/jpeg",
      metadata: {cacheControl: "private, no-store", metadata: {savrivoPurpose: "rider-aadhaar-photo", savrivoOwner: uid}}});
  } catch (error) {
    logger.warn("AADHAAR_PHOTO_CONVERT_FAILED", {uid, error: String(error)});
  }

  await identityDoc(uid).set({
    uid,
    aadhaar: {last4: qr.last4, name: qr.name, dob: qr.dob, gender: qr.gender, address: qr.address, version: qr.version, keyId,
      issuedAt: qr.issuedAt, verifiedAt: now, holderKey},
    aadhaarDuplicateOf: duplicateOf,
    photoPath,
    faceComparedFor: "",
    consentVersion: input.consentVersion,
    consentAt: now,
  }, {merge: true});
  await riders().doc(uid).set({aadhaarLast4: qr.last4, identityConsentVersion: input.consentVersion, identityConsentAt: now, identityFallback: ""}, {merge: true});
  const summary = await refreshRiderIdentity(uid, aws, now);
  return {
    name: qr.name,
    last4: qr.last4,
    birthYear: Number(qr.dob.slice(0, 4)),
    district: qr.address.district,
    state: qr.address.state,
    status: summary?.status ?? "review",
    face: summary?.face.status ?? "pending",
  };
}

function objectPathFrom(value: unknown): string {
  if (!value) return "";
  if (typeof value === "object" && value !== null && typeof (value as {path?: unknown}).path === "string") return String((value as {path: string}).path);
  const url = String(value);
  const match = url.match(/\/o\/([^?]+)/);
  if (match && match[1]) return decodeURIComponent(match[1]);
  return url.startsWith("private/") ? url : "";
}

async function signedUrl(path: string, expiresAt: number): Promise<string> {
  if (!path) return "";
  try {
    const [exists] = await storage.bucket().file(path).exists();
    if (!exists) return "";
    const [url] = await storage.bucket().file(path).getSignedUrl({version: "v4", action: "read", expires: expiresAt});
    return url;
  } catch {
    return "";
  }
}

function privileged(token: DecodedIdToken): boolean {
  return token.savrivoRole === "owner" || token.savrivoRole === "ops_admin";
}

/** Admin: the rider's checks and 5-minute links to the photos, every view logged. */
export async function getRiderIdentityReview(reviewerUid: string, token: DecodedIdToken, input: {riderUid: string}, aws: {id: string; secret: string}) {
  if (!privileged(token)) throw new DomainError("permission-denied", "An owner or operations-admin role is required.");
  const uid = input.riderUid;
  const summary = await refreshRiderIdentity(uid, aws);
  const [identitySnap, docsSnap, riderSnap] = await Promise.all([identityDoc(uid).get(), firestoreDb.collection("riderDocuments").doc(uid).get(), riders().doc(uid).get()]);
  const identity = (identitySnap.data() ?? {}) as Record<string, unknown>;
  const docsRaw = (docsSnap.data() ?? {}) as Record<string, unknown>;
  const docs = (docsRaw.documents && typeof docsRaw.documents === "object" ? docsRaw.documents : docsRaw) as Record<string, unknown>;
  const rider = (riderSnap.data() ?? {}) as Record<string, unknown>;
  const expiresAt = Date.now() + 5 * 60_000;
  const [aadhaarPhoto, face, panCopy, aadhaarFront, aadhaarBack] = await Promise.all([
    signedUrl(String(identity.photoPath || ""), expiresAt),
    signedUrl(String(rider.faceReferenceObjectPath || ""), expiresAt),
    signedUrl(objectPathFrom(docs.panCopy), expiresAt),
    signedUrl(objectPathFrom(docs.aadhaarFront), expiresAt),
    signedUrl(objectPathFrom(docs.aadhaarBack), expiresAt),
  ]);
  await firestoreDb.collection("private").doc("kycAccessAudit").collection("entries").doc().set({
    reviewerUid, riderUid: uid, documentKind: "identity-review",
    objectPathHash: createHash("sha256").update(uid).digest("hex"), accessedAt: Date.now(), expiresAt,
  });
  const aadhaar = identity.aadhaar as Record<string, unknown> | undefined;
  return {
    summary,
    aadhaar: aadhaar ? {name: aadhaar.name, last4: aadhaar.last4, dob: aadhaar.dob, gender: aadhaar.gender,
      district: (aadhaar.address as Record<string, string>)?.district, state: (aadhaar.address as Record<string, string>)?.state,
      pincode: (aadhaar.address as Record<string, string>)?.pincode, issuedAt: aadhaar.issuedAt, keyId: aadhaar.keyId,
      nameMatchesApplication: normalizeName(String(aadhaar.name)) === normalizeName(String(rider.fullName || ""))} : null,
    photos: {aadhaarPhoto, face, panCopy, aadhaarFront, aadhaarBack},
    expiresAt,
  };
}

/** Daily: remove Aadhaar images 7 days after a decision. The result stays. */
export async function enforceRiderIdentityRetention(now = Date.now()): Promise<{cleaned: number}> {
  const decided = await riders().where("status", "in", ["approved", "rejected"]).limit(500).get();
  let cleaned = 0;
  for (const doc of decided.docs) {
    const rider = doc.data() as Record<string, unknown>;
    const decidedAt = Number(rider.approvedAt || rider.rejectedAt || rider.reviewedAt || rider.updatedAt || 0);
    const identity = rider.identity as Record<string, unknown> | undefined;
    if (!decidedAt || now - decidedAt < RETENTION_MS || (identity && identity.aadhaarImagesDeletedAt)) continue;
    const docsRef = firestoreDb.collection("riderDocuments").doc(doc.id);
    const docsRaw = ((await docsRef.get()).data() ?? {}) as Record<string, unknown>;
    const docs = (docsRaw.documents && typeof docsRaw.documents === "object" ? docsRaw.documents : docsRaw) as Record<string, unknown>;
    const paths = [aadhaarPhotoPath(doc.id), objectPathFrom(docs.aadhaarFront), objectPathFrom(docs.aadhaarBack)].filter(Boolean);
    await Promise.all(paths.map((path) => storage.bucket().file(path).delete().catch(() => undefined)));
    await docsRef.set({aadhaarFront: null, aadhaarBack: null, aadhaarImagesDeletedAt: now}, {merge: true}).catch(() => undefined);
    await identityDoc(doc.id).set({photoPath: "", aadhaarImagesDeletedAt: now}, {merge: true});
    await doc.ref.set({identity: {...(identity ?? {}), aadhaarImagesDeletedAt: now}}, {merge: true});
    cleaned++;
  }
  if (cleaned) logger.info("RIDER_IDENTITY_RETENTION", {cleaned});
  return {cleaned};
}

/**
 * Gig-worker register (Code on Social Security 2020; Social Security (Central)
 * Rules 2026, Rule 48): every engaged rider and every exit, kept current
 * hourly in gigRegistry/{uid} for upload to the Shram Suvidha portal.
 */
export async function syncGigRegistry(now = Date.now()): Promise<{joined: number; exited: number}> {
  const all = await riders().where("status", "in", ["approved", "suspended", "rejected", "deactivated", "deleted"]).limit(2000).get();
  let joined = 0; let exited = 0;
  for (const doc of all.docs) {
    const rider = doc.data() as Record<string, unknown>;
    const ref = firestoreDb.collection("gigRegistry").doc(doc.id);
    const entry = (await ref.get()).data() as Record<string, unknown> | undefined;
    const identity = (await identityDoc(doc.id).get()).data() as Record<string, unknown> | undefined;
    const aadhaar = identity?.aadhaar as Record<string, unknown> | undefined;
    if (rider.status === "approved") {
      if (!entry || entry.active !== true) {
        await ref.set({
          uid: doc.id, active: true, name: String(rider.fullName || aadhaar?.name || ""), dob: String(aadhaar?.dob || ""),
          gender: String(aadhaar?.gender || ""), mobile: String(rider.phone || ""), city: String(rider.city || ""),
          state: String((aadhaar?.address as Record<string, string>)?.state || ""), aadhaarLast4: String(aadhaar?.last4 || rider.aadhaarLast4 || ""),
          eShramUan: String(rider.eShramUan || ""), engagedAt: Number(rider.approvedAt || rider.updatedAt || now),
          exitedAt: 0, joinReportedAt: 0, exitReportedAt: 0, updatedAt: now,
        }, {merge: true});
        joined++;
      }
    } else if (entry && entry.active === true) {
      await ref.set({active: false, exitedAt: now, exitReason: String(rider.status), updatedAt: now}, {merge: true});
      exited++;
    }
  }
  if (joined || exited) logger.info("GIG_REGISTRY_SYNC", {joined, exited});
  return {joined, exited};
}
