import type {DecodedIdToken} from "firebase-admin/auth";
import {firestoreDb, storage} from "../admin";
import {DomainError} from "../errors";
import {orderRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";
import {authorizeTransition} from "./authz";

/**
 * Sealed-packet photo: the restaurant photographs the sealed bag before it
 * goes to the rider, and the customer sees it on their order ("Packed and
 * sealed at 7:42 pm"). Proof for both sides if an item is missing or the
 * seal is broken. The photo stays private; the order only carries a link
 * that expires after 7 days.
 */

const LINK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 3 * 1024 * 1024;
const BEFORE_HANDOVER = ["Accepted", "Preparing", "Ready for pickup", "Assigned"];

export function packedPhotoPathOk(path: string, restaurantId: string, uid: string, orderId: string): boolean {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, "");
  if (!restaurantId || !uid || !orderId || safe(restaurantId) !== restaurantId || safe(uid) !== uid || safe(orderId) !== orderId) return false;
  return new RegExp(`^private/packed-orders/${restaurantId}/${uid}/${orderId}-[0-9]{10,16}\\.jpg$`).test(path);
}

export async function attachPackedPhoto(uid: string, token: DecodedIdToken, input: {orderId: string; path: string}, now = Date.now()) {
  const snapshot = await orderRef(firestoreDb, input.orderId).get();
  const order = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
  if (!order) throw new DomainError("not-found", "Order not found.");
  const role = await authorizeTransition(uid, token, order, "Ready for pickup");
  if (role === "customer" || role === "rider") throw new DomainError("permission-denied", "Only the restaurant can add the packet photo.");
  if (!BEFORE_HANDOVER.includes(String(order.status))) {
    throw new DomainError("failed-precondition", "The packet photo is taken before the order goes to the rider.");
  }
  if (!packedPhotoPathOk(input.path, String(order.restaurantId), uid, input.orderId)) {
    throw new DomainError("invalid-argument", "That photo can't be used for this order.");
  }
  const file = storage.bucket().file(input.path);
  const [exists] = await file.exists();
  if (!exists) throw new DomainError("failed-precondition", "The photo didn't finish uploading. Take it again.");
  const [meta] = await file.getMetadata();
  if (Number(meta.size ?? 0) > MAX_BYTES || !String(meta.contentType ?? "").startsWith("image/")) {
    throw new DomainError("invalid-argument", "That file isn't a photo we can use.");
  }
  const expiresAt = now + LINK_MS;
  const [url] = await file.getSignedUrl({version: "v4", action: "read", expires: expiresAt});
  const packedPhoto = {url, at: now, expiresAt, by: uid, path: input.path};
  await orderRef(firestoreDb, input.orderId).set({packedPhoto, updatedAt: now}, {merge: true});
  return {orderId: input.orderId, at: now};
}
