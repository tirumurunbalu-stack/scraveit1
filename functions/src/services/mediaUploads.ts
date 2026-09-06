import {createHash, randomUUID} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {z} from "zod";
import {db, storage} from "../admin";
import {ROOT} from "../config";
import {
  inspectRasterImage,
  KYC_MEDIA_DAILY_LIMIT,
  PUBLIC_MEDIA_DAILY_LIMIT,
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

export type RestaurantMediaUploadInput = z.infer<typeof restaurantMediaUploadSchema>;
export type PlatformMediaUploadInput = z.infer<typeof platformMediaUploadSchema>;
export type RiderKycUploadInput = z.infer<typeof riderKycUploadSchema>;
export type RiderKycReviewInput = z.infer<typeof riderKycReviewSchema>;

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
  const restaurantRef = db.ref(`${ROOT}/catalog/restaurants/${input.restaurantId}`);
  const restaurantSnapshot = await restaurantRef.get();
  if (!restaurantSnapshot.exists()) throw new DomainError("not-found", "Restaurant not found.");

  if (!privileged(token)) {
    const [normalized, legacy] = await Promise.all([
      db.ref(`${ROOT}/restaurantMembers/${input.restaurantId}/${uid}`).get(),
      db.ref(`${ROOT}/staff/${uid}`).get(),
    ]);
    const permission = input.kind === "menu" ? "menu" : "profile";
    if (!membershipAllows(
      normalized.val() as RestaurantMembership | null,
      input.restaurantId,
      permission,
      "path-scoped",
    ) && !membershipAllows(
      legacy.val() as RestaurantMembership | null,
      input.restaurantId,
      permission,
      "legacy-global",
    )) {
      throw new DomainError("permission-denied", `Active restaurant ${permission} permission is required.`);
    }
  }

  if (input.kind === "menu") {
    if (!input.entityId) throw new DomainError("invalid-argument", "A menu item ID is required.");
    const normalizedItem = await db.ref(`${ROOT}/menus/${input.restaurantId}/${input.entityId}`).get();
    const embeddedMenu = restaurantSnapshot.child("menu").val();
    if (!normalizedItem.exists() && !hasEmbeddedMenuItem(embeddedMenu, input.entityId)) {
      throw new DomainError("failed-precondition", "Create the menu item before uploading its image.");
    }
  } else if (input.entityId) {
    throw new DomainError("invalid-argument", "A cover upload must not include an entity ID.");
  }
}

async function reserveQuota(uid: string, category: "public" | "kyc", bytes: number): Promise<void> {
  const now = Date.now();
  const ref = db.ref(`${ROOT}/private/uploadQuotas/${uid}/${utcDayKey(now)}/${category}`);
  let exceeded = false;
  const result = await ref.transaction((current: UploadQuota | null) => {
    try {
      return reserveUploadQuota(current, bytes, category === "kyc" ? KYC_MEDIA_DAILY_LIMIT : PUBLIC_MEDIA_DAILY_LIMIT, now);
    } catch (error) {
      if (error instanceof Error && error.message === "UPLOAD_QUOTA_EXCEEDED") exceeded = true;
      return undefined;
    }
  }, undefined, false);
  if (!result.committed) {
    if (exceeded) throw new DomainError("resource-exhausted", "Daily image upload allowance reached. Try again tomorrow or contact support.");
    throw new DomainError("aborted", "Upload allowance changed; try again.");
  }
}

async function withObjectLease<T>(objectPath: string, work: () => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(objectPath).digest("hex");
  const holder = randomUUID();
  const ref = db.ref(`${ROOT}/private/mediaUploadLocks/${key}`);
  const now = Date.now();
  const lock = await ref.transaction((current: {leaseUntil?: number} | null) => {
    if (Number(current?.leaseUntil ?? 0) > now) return undefined;
    return {holder, objectPathHash: key, acquiredAt: now, leaseUntil: now + 90_000};
  }, undefined, false);
  if (!lock.committed) throw new DomainError("aborted", "Another upload is finishing for this image. Try again shortly.");
  try {
    return await work();
  } finally {
    await ref.transaction((current: {holder?: string} | null) => current?.holder === holder ? null : undefined, undefined, false);
  }
}

async function saveObject(
  objectPath: string,
  image: ReturnType<typeof inspectRasterImage>,
  ownerUid: string,
  visibility: "public" | "private",
  fields: Record<string, string>,
): Promise<{generation: string; objectPath: string}> {
  const file = storage.bucket().file(objectPath);
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
        ...fields,
      },
    },
  });
  const [metadata] = await file.getMetadata();
  const generation = String(metadata.generation ?? "");
  if (!generation) throw new DomainError("internal", "Storage did not return an object generation.");
  return {generation, objectPath};
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
  const rider = (await db.ref(`${ROOT}/riders/${uid}`).get()).val() as {status?: string} | null;
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
    const tokenlessUrl = publicObjectUrl(storage.bucket().name, objectPath, saved.generation);
    await db.ref(ROOT).update({
      [`riderDocuments/${uid}/${input.documentKind}`]: tokenlessUrl,
      [`riderDocuments/${uid}/updatedAt`]: uploadedAt,
      [`private/riderKycObjects/${uid}/${input.documentKind}`]: {
        objectPath,
        generation: saved.generation,
        contentType: image.contentType,
        size: image.buffer.length,
        width: image.width,
        height: image.height,
        sha256: image.sha256,
        uploadedAt,
      },
    });
    return {documentKind: input.documentKind, uploadedAt, sha256: image.sha256};
  });
}

export async function createRiderKycReviewUrl(
  reviewerUid: string,
  token: DecodedIdToken,
  input: RiderKycReviewInput,
): Promise<{url: string; expiresAt: number; contentType: string; size: number; sha256: string}> {
  if (!privileged(token)) throw new DomainError("permission-denied", "An owner or operations-admin role is required.");
  const record = (await db.ref(`${ROOT}/private/riderKycObjects/${input.riderUid}/${input.documentKind}`).get()).val() as KycObjectRecord | null;
  const expectedPrefix = `private/rider-kyc/${input.riderUid}/${input.documentKind}`;
  if (!record?.objectPath || record.objectPath !== expectedPrefix) throw new DomainError("not-found", "Identity document not found.");
  const file = storage.bucket().file(record.objectPath);
  const expiresAt = Date.now() + 5 * 60_000;
  const [url] = await file.getSignedUrl({version: "v4", action: "read", expires: expiresAt});
  await db.ref(`${ROOT}/private/kycAccessAudit`).push({
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
