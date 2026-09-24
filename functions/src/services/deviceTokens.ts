import type {DecodedIdToken} from "firebase-admin/auth";
import {firestoreDb} from "../admin";
import {MAX_DEVICE_TOKENS_PER_USER} from "../config";
import {deviceTokenKey, type DeviceTokenRecord, upsertDeviceToken} from "../domain/deviceTokens";
import {DomainError} from "../errors";
import {FieldValue, type DocumentReferenceLike, type FirestoreLike, type TransactionLike} from "../firestoreTypes";
import {legacyStaffRef, restaurantMemberRef, riderRef} from "../firestorePaths";
import type {RegisterDeviceTokenInput, UnregisterDeviceTokenInput} from "./serviceTypes";

function userRestaurantsRef(database: FirestoreLike, uid: string): DocumentReferenceLike {
  return database.collection("userRestaurants").doc(uid);
}

function deviceTokensRef(database: FirestoreLike, uid: string): DocumentReferenceLike {
  return database.collection("deviceTokens").doc(uid);
}

function isPrivileged(token: DecodedIdToken): boolean {
  return token.savrivoRole === "owner" || token.savrivoRole === "ops_admin";
}

async function canUseRestaurantApp(uid: string, token: DecodedIdToken): Promise<boolean> {
  if (isPrivileged(token)) return true;
  const [linksSnapshot, legacySnapshot] = await Promise.all([
    userRestaurantsRef(firestoreDb, uid).get(),
    legacyStaffRef(firestoreDb, uid).get(),
  ]);
  const legacy = (legacySnapshot.exists ? legacySnapshot.data() : null) as {active?: boolean} | null;
  if (legacy?.active === true) return true;
  const links = (linksSnapshot.exists ? linksSnapshot.data() : null) as Record<string, boolean> | null;
  const restaurantIds = Object.entries(links ?? {}).filter(([, active]) => active === true).map(([restaurantId]) => restaurantId);
  const memberships = await Promise.all(restaurantIds.slice(0, 50)
    .map(async (restaurantId) => {
      const snapshot = await restaurantMemberRef(firestoreDb, restaurantId, uid).get();
      return (snapshot.exists ? snapshot.data() : null) as {active?: boolean} | null;
    }));
  return memberships.some((member) => member?.active === true);
}

async function authorizeDeviceApp(
  uid: string,
  token: DecodedIdToken,
  app: RegisterDeviceTokenInput["app"],
): Promise<void> {
  if (app === "customer") return;
  if (app === "admin") {
    if (isPrivileged(token)) return;
    throw new DomainError("permission-denied", "Admin notification registration requires an admin role.");
  }
  if (app === "restaurant") {
    if (await canUseRestaurantApp(uid, token)) return;
    throw new DomainError("permission-denied", "Restaurant notification registration requires an active membership.");
  }
  const riderSnapshot = await riderRef(firestoreDb, uid).get();
  const rider = (riderSnapshot.exists ? riderSnapshot.data() : null) as {status?: string} | null;
  if (rider && ["submitted", "under_review", "approved", "rejected", "suspended"].includes(String(rider.status))) return;
  throw new DomainError("permission-denied", "Rider notification registration requires a partner profile.");
}

export async function registerDeviceToken(
  uid: string,
  authToken: DecodedIdToken,
  input: RegisterDeviceTokenInput,
): Promise<{tokenId: string; updatedAt: number}> {
  await authorizeDeviceApp(uid, authToken, input.app);
  const ref = deviceTokensRef(firestoreDb, uid);
  const now = Date.now();
  const tokenId = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = (snapshot.exists ? snapshot.data() : null) as Record<string, DeviceTokenRecord> | null;
    let next: ReturnType<typeof upsertDeviceToken>;
    try {
      next = upsertDeviceToken(current, {
        token: input.token,
        app: input.app,
        platform: input.platform,
        appVersion: input.appVersion,
        deviceModel: input.deviceModel,
        enabled: true,
      }, now, MAX_DEVICE_TOKENS_PER_USER);
    } catch (error) {
      if (error instanceof Error && error.message === "DEVICE_TOKEN_CAP_REACHED") {
        throw new DomainError("resource-exhausted", `This account already has ${MAX_DEVICE_TOKENS_PER_USER} registered devices. Remove an old device first.`);
      }
      throw new DomainError("aborted", "Device registration changed; try again.");
    }
    transaction.set(ref, next.tokens);
    return next.key;
  });
  return {tokenId, updatedAt: now};
}

export async function unregisterDeviceToken(uid: string, input: UnregisterDeviceTokenInput): Promise<{removed: boolean}> {
  const ref = deviceTokensRef(firestoreDb, uid);
  const snapshot = await ref.get();
  const tokens = (snapshot.exists ? snapshot.data() : {}) as Record<string, DeviceTokenRecord>;
  const key = deviceTokenKey(input.token);
  const existed = Object.prototype.hasOwnProperty.call(tokens, key);
  if (existed) await ref.update({[key]: FieldValue.delete()});
  return {removed: existed};
}
