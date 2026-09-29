import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import {riderRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";

/**
 * Keeps riders/{uid}.deliveredOrderCount: the "N deliveries" customers see on
 * the rider card. Each order is counted once through a marker, so retried
 * delivery events never inflate it. The first time a rider has no count yet,
 * it is filled from their existing delivered orders.
 */
export async function recordRiderDeliveredOrder(
  order: SavrivoOrder,
  database: FirestoreLike = firestoreDb,
): Promise<void> {
  const riderId = String(order.riderId ?? "");
  if (!riderId || order.status !== "Delivered") return;
  const profileRef = riderRef(database, riderId);
  const markers = database.collection("riderDeliveredOrders");
  const profile = await profileRef.get();
  if (!profile.exists) return;
  const current = Number((profile.data() as Record<string, unknown>).deliveredOrderCount);
  if (!Number.isFinite(current)) {
    const delivered = await database.collection("orders")
      .where("riderId", "==", riderId).where("status", "==", "Delivered").get();
    const ids = delivered.docs.map((doc) => doc.id);
    for (let start = 0; start < ids.length; start += 400) {
      const batch = database.batch();
      for (const id of ids.slice(start, start + 400)) batch.set(markers.doc(id), {riderId, source: "backfill"});
      await batch.commit();
    }
    await database.runTransaction(async (transaction: TransactionLike) => {
      const snapshot = await transaction.get(profileRef);
      const data = (snapshot.exists ? snapshot.data() : null) as Record<string, unknown> | null;
      if (!data || Number.isFinite(Number(data.deliveredOrderCount))) return;
      transaction.set(profileRef, {deliveredOrderCount: ids.length}, {merge: true});
    });
    logger.info("RIDER_DELIVERED_COUNT_BACKFILLED", {riderId, count: ids.length});
  }
  await database.runTransaction(async (transaction: TransactionLike) => {
    const markerRef = markers.doc(order.id);
    const [marker, snapshot] = await Promise.all([transaction.get(markerRef), transaction.get(profileRef)]);
    if (marker.exists || !snapshot.exists) return;
    const count = Number((snapshot.data() as Record<string, unknown>).deliveredOrderCount);
    transaction.set(markerRef, {riderId, source: "delivery"});
    transaction.set(profileRef, {deliveredOrderCount: (Number.isFinite(count) ? count : 0) + 1}, {merge: true});
  });
}

/** What the customer's rider card may show: a rating once there is one, and
 * the delivery count. Nothing else from the rider profile leaves the server. */
export function riderPublicStats(rider: Record<string, unknown>): {riderRating?: number; riderDeliveredCount?: number} {
  const rating = Number(rider.rating);
  const ratingCount = Number(rider.ratingCount);
  const delivered = Number(rider.deliveredOrderCount);
  return {
    ...(ratingCount > 0 && rating >= 1 && rating <= 5 ? {riderRating: Math.round(rating * 10) / 10} : {}),
    ...(Number.isFinite(delivered) && delivered >= 0 ? {riderDeliveredCount: Math.floor(delivered)} : {}),
  };
}
