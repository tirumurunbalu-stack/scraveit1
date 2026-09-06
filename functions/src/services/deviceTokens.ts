import type {DecodedIdToken} from "firebase-admin/auth";
import {db} from "../admin";
import {MAX_DEVICE_TOKENS_PER_USER, ROOT} from "../config";
import {deviceTokenKey, type DeviceTokenRecord, upsertDeviceToken} from "../domain/deviceTokens";
import {DomainError} from "../errors";
import type {RegisterDeviceTokenInput, UnregisterDeviceTokenInput} from "./serviceTypes";

function isPrivileged(token: DecodedIdToken): boolean {
  return token.savrivoRole === "owner" || token.savrivoRole === "ops_admin";
}

async function canUseRestaurantApp(uid: string, token: DecodedIdToken): Promise<boolean> {
  if (isPrivileged(token)) return true;
  const [linksSnapshot, legacySnapshot] = await Promise.all([
    db.ref(`${ROOT}/userRestaurants/${uid}`).get(),
    db.ref(`${ROOT}/staff/${uid}`).get(),
  ]);
  const legacy = legacySnapshot.val() as {active?: boolean} | null;
  if (legacy?.active === true) return true;
  const links = linksSnapshot.val() as Record<string, boolean> | null;
  const restaurantIds = Object.entries(links ?? {}).filter(([, active]) => active === true).map(([restaurantId]) => restaurantId);
  const memberships = await Promise.all(restaurantIds.slice(0, 50)
    .map((restaurantId) => db.ref(`${ROOT}/restaurantMembers/${restaurantId}/${uid}/active`).get()));
  return memberships.some((snapshot) => snapshot.val() === true);
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
  const rider = (await db.ref(`${ROOT}/riders/${uid}`).get()).val() as {status?: string} | null;
  if (rider && ["submitted", "under_review", "approved", "rejected", "suspended"].includes(String(rider.status))) return;
  throw new DomainError("permission-denied", "Rider notification registration requires a partner profile.");
}

export async function registerDeviceToken(
  uid: string,
  authToken: DecodedIdToken,
  input: RegisterDeviceTokenInput,
): Promise<{tokenId: string; updatedAt: number}> {
  await authorizeDeviceApp(uid, authToken, input.app);
  const ref = db.ref(`${ROOT}/deviceTokens/${uid}`);
  const now = Date.now();
  let tokenId = deviceTokenKey(input.token);
  let capReached = false;
  const result = await ref.transaction((current: Record<string, DeviceTokenRecord> | null) => {
    try {
      const next = upsertDeviceToken(current, {
        token: input.token,
        app: input.app,
        platform: input.platform,
        appVersion: input.appVersion,
        deviceModel: input.deviceModel,
        enabled: true,
      }, now, MAX_DEVICE_TOKENS_PER_USER);
      tokenId = next.key;
      return next.tokens;
    } catch (error) {
      if (error instanceof Error && error.message === "DEVICE_TOKEN_CAP_REACHED") capReached = true;
      return undefined;
    }
  }, undefined, false);
  if (!result.committed) {
    if (capReached) throw new DomainError("resource-exhausted", `This account already has ${MAX_DEVICE_TOKENS_PER_USER} registered devices. Remove an old device first.`);
    throw new DomainError("aborted", "Device registration changed; try again.");
  }
  return {tokenId, updatedAt: now};
}

export async function unregisterDeviceToken(uid: string, input: UnregisterDeviceTokenInput): Promise<{removed: boolean}> {
  const ref = db.ref(`${ROOT}/deviceTokens/${uid}/${deviceTokenKey(input.token)}`);
  const existed = (await ref.get()).exists();
  if (existed) await ref.remove();
  return {removed: existed};
}
