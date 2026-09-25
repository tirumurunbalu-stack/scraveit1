import {createHash, randomUUID} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {z} from "zod";
import {firestoreDb, storage} from "../admin";
import {
  inspectRasterImage,
  KYC_MEDIA_DAILY_LIMIT,
  PUBLIC_MEDIA_DAILY_LIMIT,
  privateObjectUrl,
  publicObjectUrl,
  reserveUploadQuota,
  type SupportedImageType,
  type UploadQuota,
  utcDayKey,
} from "../domain/mediaUpload";
import {
  isActiveMembershipForRestaurant,
  type RestaurantMembership,
  type RestaurantMembershipSource,
} from "../domain/restaurantAccess";
import {DomainError} from "../errors";
import type {DocumentReferenceLike, FirestoreLike, TransactionLike, WriteBatchLike} from "../firestoreTypes";
import {legacyStaffRef, menuItemRef, restaurantMemberRef, restaurantRef, riderRef} from "../firestorePaths";
import {checkRiderFaceUniqueness, compareRiderLoginFace, indexRiderFaceDirectly} from "./faceVerification";

function uploadQuotaRef(database: FirestoreLike, uid: string, dayKey: string, category: "public" | "kyc"): DocumentReferenceLike {
  return database.collection("uploadQuotas").doc(`${uid}_${dayKey}_${category}`);
}
function mediaUploadLockRef(database: FirestoreLike, key: string): DocumentReferenceLike {
  return database.collection("mediaUploadLocks").doc(key);
}
function riderKycObjectRef(database: FirestoreLike, uid: string, documentKind: string): DocumentReferenceLike {
  return database.collection("riderKycObjects").doc(`${uid}_${documentKind}`);
}
function riderDocumentsRef(database: FirestoreLike, uid: string): DocumentReferenceLike {
  return database.collection("riderDocuments").doc(uid);
}
function riderFaceObjectRef(database: FirestoreLike, uid: string): DocumentReferenceLike {
  return database.collection("riderFaceObjects").doc(uid);
}

const identifier = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const contentType = z.enum(["image/jpeg", "image/png", "image/webp"]);
const hash = z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/).optional();
const encodedImage = z.string().min(4).max(3_400_000);

export const restaurantMediaUploadSchema = z.object({
  restaurantId: identifier,
  kind: z.enum(["cover", "menu"]),
  entityId: identifier.optional(),
  contentType,
  dataBase64: encodedImage,
  sha256: hash,
}).strict();

export const platformMediaUploadSchema = z.object({
  kind: z.enum(["ads", "banners"]),
  entityId: identifier,
  contentType,
  dataBase64: encodedImage,
  sha256: hash,
}).strict();

export const riderKycUploadSchema = z.object({
  documentKind: z.enum(["aadhaarFront", "aadhaarBack", "panCopy"]),
  contentType,
  dataBase64: z.string().min(4).max(2_100_000),
  sha256: hash,
}).strict();

export const riderKycReviewSchema = z.object({
  riderUid: z.string().trim().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/),
  documentKind: z.enum(["aadhaarFront", "aadhaarBack", "panCopy"]),
}).strict();

export const riderFaceImageSchema = z.object({
  contentType,
  dataBase64: z.string().min(4).max(2_100_000),
  sha256: hash,
}).strict();

export const resolveRiderFaceReviewSchema = z.object({
  riderUid: z.string().trim().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export type RestaurantMediaUploadInput = z.infer<typeof restaurantMediaUploadSchema>;
export type PlatformMediaUploadInput = z.infer<typeof platformMediaUploadSchema>;
export type RiderKycUploadInput = z.infer<typeof riderKycUploadSchema>;
export type RiderKycReviewInput = z.infer<typeof riderKycReviewSchema>;
export type RiderFaceImageInput = z.infer<typeof riderFaceImageSchema>;
export type ResolveRiderFaceReviewInput = z.infer<typeof resolveRiderFaceReviewSchema>;

interface KycObjectRecord {
  objectPath?: string;
  contentType?: string;
  size?: number;
  sha256?: string;
  uploadedAt?: number;
}

function privileged(token: DecodedIdToken): boolean {
  return token.savrivoRole === "owner" || token.savrivoRole === "ops_admin";
}

function membershipAllows(
  member: RestaurantMembership | null,
  restaurantId: string,
  permission: "profile" | "menu",
  source: RestaurantMembershipSource,
): boolean {
  if (!member || !isActiveMembershipForRestaurant(member, restaurantId, source)) return false;
  return ["restaurant_owner", "restaurant_manager"].includes(String(member.role ?? "")) || member.permissions?.[permission] === true;
}

function hasEmbeddedMenuItem(value: unknown, itemId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => item && typeof item === "object" && String((item as {id?: unknown}).id ?? "") === itemId);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(record, itemId) || Object.values(record)
      .some((item) => item && typeof item === "object" && String((item as {id?: unknown}).id ?? "") === itemId);
  }
  return false;
}

export async function requireRestaurantMediaAccess(
  uid: string,
  token: DecodedIdToken,
  input: RestaurantMediaUploadInput,
): Promise<void> {
  const restaurantSnapshot = await restaurantRef(firestoreDb, input.restaurantId).get();
  if (!restaurantSnapshot.exists) throw new DomainError("not-found", "Restaurant not found.");

  if (!privileged(token)) {
    const [normalized, legacy] = await Promise.all([
      restaurantMemberRef(firestoreDb, input.restaurantId, uid).get(),
      legacyStaffRef(firestoreDb, uid).get(),
    ]);
    const permission = input.kind === "menu" ? "menu" : "profile";
    if (!membershipAllows(
      (normalized.exists ? normalized.data() : null) as RestaurantMembership | null,
      input.restaurantId,
      permission,
      "path-scoped",
    ) && !membershipAllows(
      (legacy.exists ? legacy.data() : null) as RestaurantMembership | null,
      input.restaurantId,
      permission,
      "legacy-global",
    )) {
      throw new DomainError("permission-denied", `Active restaurant ${permission} permission is required.`);
    }
  }

  if (input.kind === "menu") {
    if (!input.entityId) throw new DomainError("invalid-argument", "A menu item ID is required.");
    const normalizedItem = await menuItemRef(firestoreDb, input.restaurantId, input.entityId).get();
    const embeddedMenu = (restaurantSnapshot.data() as {menu?: unknown} | null)?.menu;
    if (!normalizedItem.exists && !hasEmbeddedMenuItem(embeddedMenu, input.entityId)) {
      throw new DomainError("failed-precondition", "Create the menu item before uploading its image.");
    }
  } else if (input.entityId) {
    throw new DomainError("invalid-argument", "A cover upload must not include an entity ID.");
  }
}

async function reserveQuota(uid: string, category: "public" | "kyc", bytes: number): Promise<void> {
  const now = Date.now();
  const ref = uploadQuotaRef(firestoreDb, uid, utcDayKey(now), category);
  let exceeded = false;
  const committed = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as UploadQuota : null;
    let next: UploadQuota;
    try {
      next = reserveUploadQuota(current, bytes, category === "kyc" ? KYC_MEDIA_DAILY_LIMIT : PUBLIC_MEDIA_DAILY_LIMIT, now);
    } catch (error) {
      if (error instanceof Error && error.message === "UPLOAD_QUOTA_EXCEEDED") exceeded = true;
      return false;
    }
    transaction.set(ref, next);
    return true;
  });
  if (!committed) {
    if (exceeded) throw new DomainError("resource-exhausted", "Daily image upload allowance reached. Try again tomorrow or contact support.");
    throw new DomainError("aborted", "Upload allowance changed; try again.");
  }
}

async function withObjectLease<T>(objectPath: string, work: () => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(objectPath).digest("hex");
  const holder = randomUUID();
  const ref = mediaUploadLockRef(firestoreDb, key);
  const now = Date.now();
  const acquired = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as {leaseUntil?: number} : null;
    if (Number(current?.leaseUntil ?? 0) > now) return false;
    transaction.set(ref, {holder, objectPathHash: key, acquiredAt: now, leaseUntil: now + 90_000});
    return true;
  });
  if (!acquired) throw new DomainError("aborted", "Another upload is finishing for this image. Try again shortly.");
  try {
    return await work();
  } finally {
    await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() as {holder?: string} : null;
      if (current?.holder === holder) transaction.delete(ref);
    });
  }
}

async function saveObject(
  objectPath: string,
  image: ReturnType<typeof inspectRasterImage>,
  ownerUid: string,
  visibility: "public" | "private",
  fields: Record<string, string>,
): Promise<{generation: string; objectPath: string; downloadToken?: string}> {
  const file = storage.bucket().file(objectPath);
  // A private object has no public-read Storage rule, so a downstream
  // caller wanting a plain <img src> URL for it (no Authorization header
  // possible) needs Firebase's own download-token mechanism, stamped into
  // the object's metadata here.
  const downloadToken = visibility === "private" ? randomUUID() : undefined;
  await file.save(image.buffer, {
    resumable: false,
    validation: "crc32c",
    metadata: {
      contentType: image.contentType,
      cacheControl: visibility === "private" ? "private, no-store, max-age=0" : "public, max-age=31536000, immutable",
      contentDisposition: "inline",
      metadata: {
        savrivoOwnerUid: ownerUid,
        savrivoVisibility: visibility,
        savrivoSha256: image.sha256,
        savrivoWidth: String(image.width),
        savrivoHeight: String(image.height),
        ...(downloadToken ? {firebaseStorageDownloadTokens: downloadToken} : {}),
        ...fields,
      },
    },
  });
  const [metadata] = await file.getMetadata();
  const generation = String(metadata.generation ?? "");
  if (!generation) throw new DomainError("internal", "Storage did not return an object generation.");
  return {generation, objectPath, downloadToken};
}

function inspect(input: {dataBase64: string; contentType: SupportedImageType; sha256?: string}, purpose: "public" | "kyc") {
  try {
    return inspectRasterImage(input.dataBase64, input.contentType, purpose, input.sha256);
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_IMAGE";
    throw new DomainError("invalid-argument", `Image rejected: ${code}.`);
  }
}

export async function uploadRestaurantMediaObject(
  uid: string,
  token: DecodedIdToken,
  input: RestaurantMediaUploadInput,
): Promise<{objectPath: string; imageUrl: string; width: number; height: number; sha256: string}> {
  await requireRestaurantMediaAccess(uid, token, input);
  const image = inspect(input, "public");
  const objectPath = input.kind === "cover" ? `media/restaurants/${input.restaurantId}/cover` :
    `media/restaurants/${input.restaurantId}/menu/${input.entityId!}`;
  return withObjectLease(objectPath, async () => {
    await reserveQuota(uid, "public", image.buffer.length);
    const saved = await saveObject(objectPath, image, uid, "public", {
      savrivoPurpose: input.kind,
      savrivoRestaurantId: input.restaurantId,
      ...(input.entityId ? {savrivoEntityId: input.entityId} : {}),
    });
    return {
      objectPath,
      imageUrl: publicObjectUrl(storage.bucket().name, objectPath, saved.generation),
      width: image.width,
      height: image.height,
      sha256: image.sha256,
    };
  });
}

export async function uploadPlatformMediaObject(
  uid: string,
  token: DecodedIdToken,
  input: PlatformMediaUploadInput,
): Promise<{objectPath: string; imageUrl: string; width: number; height: number; sha256: string}> {
  if (!privileged(token)) throw new DomainError("permission-denied", "An owner or operations-admin role is required.");
  const image = inspect(input, "public");
  const objectPath = `media/platform/${input.kind}/${input.entityId}`;
  return withObjectLease(objectPath, async () => {
    await reserveQuota(uid, "public", image.buffer.length);
    const saved = await saveObject(objectPath, image, uid, "public", {
      savrivoPurpose: input.kind,
      savrivoEntityId: input.entityId,
    });
    return {
      objectPath,
      imageUrl: publicObjectUrl(storage.bucket().name, objectPath, saved.generation),
      width: image.width,
      height: image.height,
      sha256: image.sha256,
    };
  });
}

export async function uploadRiderKycObject(
  uid: string,
  input: RiderKycUploadInput,
): Promise<{documentKind: RiderKycUploadInput["documentKind"]; uploadedAt: number; sha256: string}> {
  const riderSnapshot = await riderRef(firestoreDb, uid).get();
  const rider = (riderSnapshot.exists ? riderSnapshot.data() : null) as {status?: string} | null;
  if (rider && ["approved", "suspended"].includes(String(rider.status ?? ""))) {
    throw new DomainError("failed-precondition", "Approved or suspended identity documents require an administrator-led re-verification.");
  }
  const image = inspect(input, "kyc");
  const objectPath = `private/rider-kyc/${uid}/${input.documentKind}`;
  return withObjectLease(objectPath, async () => {
    await reserveQuota(uid, "kyc", image.buffer.length);
    const saved = await saveObject(objectPath, image, uid, "private", {
      savrivoPurpose: "rider-kyc",
      savrivoDocumentKind: input.documentKind,
    });
    const uploadedAt = Date.now();
    const downloadUrl = saved.downloadToken
      ? privateObjectUrl(storage.bucket().name, objectPath, saved.downloadToken)
      : publicObjectUrl(storage.bucket().name, objectPath, saved.generation);
    const batch: WriteBatchLike = firestoreDb.batch();
    batch.set(riderDocumentsRef(firestoreDb, uid), {
      [input.documentKind]: downloadUrl,
      updatedAt: uploadedAt,
    }, {merge: true});
    batch.set(riderKycObjectRef(firestoreDb, uid, input.documentKind), {
      objectPath,
      generation: saved.generation,
      contentType: image.contentType,
      size: image.buffer.length,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
      uploadedAt,
    });
    await batch.commit();
    return {documentKind: input.documentKind, uploadedAt, sha256: image.sha256};
  });
}

export async function createRiderKycReviewUrl(
  reviewerUid: string,
  token: DecodedIdToken,
  input: RiderKycReviewInput,
): Promise<{url: string; expiresAt: number; contentType: string; size: number; sha256: string}> {
  if (!privileged(token)) throw new DomainError("permission-denied", "An owner or operations-admin role is required.");
  const recordSnapshot = await riderKycObjectRef(firestoreDb, input.riderUid, input.documentKind).get();
  const record = (recordSnapshot.exists ? recordSnapshot.data() : null) as KycObjectRecord | null;
  const expectedPrefix = `private/rider-kyc/${input.riderUid}/${input.documentKind}`;
  if (!record?.objectPath || record.objectPath !== expectedPrefix) throw new DomainError("not-found", "Identity document not found.");
  const file = storage.bucket().file(record.objectPath);
  const expiresAt = Date.now() + 5 * 60_000;
  const [url] = await file.getSignedUrl({version: "v4", action: "read", expires: expiresAt});
  await firestoreDb.collection("private").doc("kycAccessAudit").collection("entries").doc().set({
    reviewerUid,
    riderUid: input.riderUid,
    documentKind: input.documentKind,
    objectPathHash: createHash("sha256").update(record.objectPath).digest("hex"),
    accessedAt: Date.now(),
    expiresAt,
  });
  return {
    url,
    expiresAt,
    contentType: String(record.contentType ?? "application/octet-stream"),
    size: Number(record.size ?? 0),
    sha256: String(record.sha256 ?? ""),
  };
}

interface RiderFaceState {
  status?: string;
  faceMatchStatus?: "unique" | "needs_review";
}

/**
 * Signup-time face check: one rider, one account, no matter how many emails
 * or documents someone cycles through - searches every previously indexed
 * rider's face, and only indexes this one as new if nothing matched. A match
 * never blocks the application outright; it parks it as "needs_review" for
 * an Admin to confirm before anyone is refused on a false positive.
 */
export async function submitRiderFaceCheck(
  uid: string,
  input: RiderFaceImageInput,
  awsAccessKeyId: string,
  awsSecretAccessKey: string,
): Promise<{status: "unique" | "needs_review"}> {
  const riderSnapshot = await riderRef(firestoreDb, uid).get();
  const rider = (riderSnapshot.exists ? riderSnapshot.data() : null) as RiderFaceState | null;
  if (rider?.faceMatchStatus === "unique") {
    throw new DomainError("failed-precondition", "Identity already verified for this account.");
  }
  // Deliberately no status==="approved"/"suspended" block here (unlike the
  // KYC document upload above): this same function doubles as the one-time
  // enrollment path for riders approved before face verification existed -
  // their first post-rollout login has no reference photo to compare yet,
  // so it calls this (search-and-index), not the 1:1 login compare. The
  // faceMatchStatus==="unique" check above already closes the real risk
  // (silently swapping a verified account's face after the fact); nothing
  // about an approved rider having no face record yet should stay blocked.
  const image = inspect(input, "kyc");
  const objectPath = `private/rider-face/${uid}/reference`;
  return withObjectLease(objectPath, async () => {
    await reserveQuota(uid, "kyc", image.buffer.length);
    const result = await checkRiderFaceUniqueness(awsAccessKeyId, awsSecretAccessKey, uid, image.buffer);
    const saved = await saveObject(objectPath, image, uid, "private", {savrivoPurpose: "rider-face-reference"});
    const now = Date.now();
    // Same download-token URL pattern used for riderDocuments (KYC
    // photos): lets the Admin app show this face photo with a plain
    // <img src>, no signed-URL round trip, so a reviewer comparing a
    // flagged match can see both faces without any native app change.
    const faceReferenceUrl = saved.downloadToken
      ? privateObjectUrl(storage.bucket().name, objectPath, saved.downloadToken)
      : publicObjectUrl(storage.bucket().name, objectPath, saved.generation);
    const batch: WriteBatchLike = firestoreDb.batch();
    batch.set(riderFaceObjectRef(firestoreDb, uid), {
      objectPath,
      generation: saved.generation,
      contentType: image.contentType,
      size: image.buffer.length,
      sha256: image.sha256,
      uploadedAt: now,
    });
    batch.set(riderRef(firestoreDb, uid), result.status === "unique" ? {
      faceMatchStatus: "unique",
      rekognitionFaceId: result.rekognitionFaceId,
      faceMatchCandidates: [],
      faceReferenceObjectPath: objectPath,
      faceReferenceUrl,
      faceIndexedAt: now,
    } : {
      faceMatchStatus: "needs_review",
      faceMatchCandidates: result.status === "needs_review" ? result.candidates : [],
      faceReferenceObjectPath: objectPath,
      faceReferenceUrl,
      faceCheckedAt: now,
    }, {merge: true});
    await batch.commit();
    return {status: result.status};
  });
}

/**
 * Login-time face check: a plain 1:1 compare against the one reference photo
 * captured at signup - not a database search, so a routine login never has
 * to scan every other rider's face.
 */
export async function verifyRiderLoginFace(
  uid: string,
  input: RiderFaceImageInput,
  awsAccessKeyId: string,
  awsSecretAccessKey: string,
): Promise<{verified: boolean}> {
  const startedAt = Date.now();
  const riderSnapshot = await riderRef(firestoreDb, uid).get();
  const rider = (riderSnapshot.exists ? riderSnapshot.data() : null) as
    {faceReferenceObjectPath?: string; faceMatchStatus?: string} | null;
  if (!rider?.faceReferenceObjectPath || rider.faceMatchStatus !== "unique") {
    throw new DomainError("failed-precondition", "Complete identity verification before signing in.");
  }
  const image = inspect(input, "kyc");
  const profileMs = Date.now() - startedAt;
  const [referenceBuffer] = await storage.bucket().file(rider.faceReferenceObjectPath).download();
  const downloadMs = Date.now() - startedAt - profileMs;
  const result = await compareRiderLoginFace(awsAccessKeyId, awsSecretAccessKey, uid, referenceBuffer, image.buffer);
  logger.info("RIDER_LOGIN_FACE_TIMING", {
    uid, verified: result.verified, profileMs, downloadMs,
    compareMs: Date.now() - startedAt - profileMs - downloadMs, totalMs: Date.now() - startedAt,
    liveImageBytes: image.buffer.length, referenceBytes: referenceBuffer.length,
  });
  return {verified: result.verified};
}

/**
 * An owner/ops_admin clears a signup-time face match they've confirmed is a
 * false positive (two genuinely different people) - the rider's reference
 * photo is indexed for real at this point, same as an unmatched signup
 * would have been, so a genuine future duplicate of THIS rider is still
 * caught. Does nothing to the application's own approve/reject status;
 * that stays a separate, already-existing admin action.
 */
export async function resolveRiderFaceReview(
  reviewerUid: string,
  token: DecodedIdToken,
  input: ResolveRiderFaceReviewInput,
  awsAccessKeyId: string,
  awsSecretAccessKey: string,
): Promise<{status: "unique"}> {
  if (!privileged(token)) throw new DomainError("permission-denied", "An owner or operations-admin role is required.");
  const riderSnapshot = await riderRef(firestoreDb, input.riderUid).get();
  const rider = (riderSnapshot.exists ? riderSnapshot.data() : null) as
    {faceMatchStatus?: string; faceReferenceObjectPath?: string} | null;
  if (!rider || rider.faceMatchStatus !== "needs_review" || !rider.faceReferenceObjectPath) {
    throw new DomainError("failed-precondition", "This rider has no pending face match to resolve.");
  }
  const [referenceBuffer] = await storage.bucket().file(rider.faceReferenceObjectPath).download();
  const result = await indexRiderFaceDirectly(awsAccessKeyId, awsSecretAccessKey, input.riderUid, referenceBuffer);
  const now = Date.now();
  await riderRef(firestoreDb, input.riderUid).set({
    faceMatchStatus: "unique",
    rekognitionFaceId: result.rekognitionFaceId,
    faceMatchCandidates: [],
    faceIndexedAt: now,
    faceReviewedAt: now,
    faceReviewedBy: reviewerUid,
  }, {merge: true});
  return {status: "unique"};
}
