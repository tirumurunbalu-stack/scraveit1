import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {nextPairState, pairDocId, readPairState, samePhone, type PairFlagReason} from "../domain/pairWatch";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import type {SavrivoOrder} from "../types";
import {alertAdmins} from "./adminAlerts";

const watchRoot = (database: FirestoreLike) => database.collection("private").doc("abuseWatch");
export const pairRef = (database: FirestoreLike, id: string) => watchRoot(database).collection("pairs").doc(id);
export const abuseFlagsRef = (database: FirestoreLike) => watchRoot(database).collection("flags");

/**
 * On every delivery: keep the last 30 days of this partner–customer pair and
 * flag it for the admin when it repeats too often. Never blocks anything.
 */
export async function recordPartnerCustomerPair(
  order: SavrivoOrder,
  database: FirestoreLike = firestoreDb as unknown as FirestoreLike,
): Promise<{flag: PairFlagReason | null; dayCount: number; weekCount: number}> {
  const riderId = String(order.riderId ?? "").trim();
  const customerId = String(order.customerId ?? "").trim();
  if (order.status !== "Delivered" || !riderId || !customerId || order.selfDelivery === true) {
    return {flag: null, dayCount: 0, weekCount: 0};
  }
  const at = Number(order.deliveredAt ?? order.updatedAt) || Date.now();
  const id = pairDocId(riderId, customerId);
  const ownPhone = samePhone(order.riderPhone, order.customerPhone);
  const result = await database.runTransaction(async (transaction: TransactionLike) => {
    const ref = pairRef(database, id);
    const snapshot = await transaction.get(ref);
    const next = nextPairState(readPairState(snapshot.exists ? snapshot.data() : null), {orderId: order.id, at}, ownPhone);
    if (next.duplicate) return next;
    transaction.set(ref, {riderId, customerId, ...next.state, updatedAt: at});
    if (next.flag) {
      transaction.set(abuseFlagsRef(database).doc(`${id}__${at}`), {
        kind: next.flag,
        riderId,
        riderName: String(order.riderName ?? ""),
        customerId,
        customerName: String(order.customerName ?? ""),
        dayCount: next.dayCount,
        weekCount: next.weekCount,
        orderIds: next.state.deliveries.slice(-10).map((entry) => entry.orderId),
        at,
        status: "open",
      });
    }
    return next;
  });
  if (result.flag) {
    logger.warn("PARTNER_CUSTOMER_PAIR_FLAG", {riderId, customerId, flag: result.flag, dayCount: result.dayCount, weekCount: result.weekCount});
    const body = result.flag === "own_phone" ?
      "A delivery partner delivered an order placed from their own phone number. Check it before bonuses are paid." :
      `One delivery partner delivered to the same customer ${result.dayCount} times today (${result.weekCount} in 7 days). Check for fake orders.`;
    await alertAdmins(`pair:${id}:${at}`, "Same partner and customer again", body, `rider:${riderId}`)
      .catch((error) => logger.warn("PAIR_FLAG_ALERT_FAILED", {riderId, error: String(error)}));
  }
  return {flag: result.flag, dayCount: result.dayCount, weekCount: result.weekCount};
}

/** Latest flags for the admin page, newest first. */
export async function listAbuseFlags(database: FirestoreLike = firestoreDb as unknown as FirestoreLike, limit = 50): Promise<Record<string, unknown>[]> {
  const snapshot = await abuseFlagsRef(database).orderBy("at", "desc").limit(limit).get();
  return snapshot.docs.map((doc) => ({id: doc.id, ...(doc.data() as Record<string, unknown>)}));
}
