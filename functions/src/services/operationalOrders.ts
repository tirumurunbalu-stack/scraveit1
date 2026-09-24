import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {
  buildOperationalOrderProjection,
  isOperationalOrderActive,
  shouldApplyOperationalOrderProjection,
  type OperationalOrderProjection,
} from "../domain/operationalOrders";
import {isLegacyOrderStatus} from "../domain/lifecycle";
import type {CollectionReferenceLike, TransactionLike} from "../firestoreTypes";
import type {SavrivoOrder} from "../types";

export const OPERATIONAL_ORDERS_MAX_PAGE = 250;

function operationalOrdersCollectionRef(): CollectionReferenceLike {
  // Named distinctly from the top-level `orders` collection so a collection-
  // group index/query for one never accidentally matches the other.
  return firestoreDb.collection("private").doc("operations").collection("operationalOrders");
}

function pageSize(value: unknown): number {
  const size = Number(value);
  return Number.isInteger(size) ? Math.max(1, Math.min(OPERATIONAL_ORDERS_MAX_PAGE, size)) : 100;
}

/**
 * Verified rider restaurant arrival is written directly onto this projection
 * (never derived from the order itself - `SavrivoOrder` carries no arrival
 * fields), so `riderRestaurantArrival.ts` calls this the moment the server
 * verifies arrival rather than waiting for the next status-driven reconcile.
 */
export async function applyRiderArrivalToOperationalProjection(
  orderId: string,
  arrivedAt: number,
): Promise<void> {
  await operationalOrdersCollectionRef().doc(orderId)
    .set({riderArrivalVerified: true, riderArrivedRestaurantAt: arrivedAt}, {merge: true});
}

export async function reconcileOperationalOrderProjection(
  order: SavrivoOrder,
): Promise<OperationalOrderProjection> {
  const ref = operationalOrdersCollectionRef().doc(order.id);
  let applied = false;
  const projection = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as OperationalOrderProjection : null;
    const next = buildOperationalOrderProjection(order, current);
    if (!shouldApplyOperationalOrderProjection(current, next)) return current ?? next;
    transaction.set(ref, next);
    applied = true;
    return next;
  });
  if (!applied) {
    logger.info("STALE_OPERATIONAL_ORDER_PROJECTION_IGNORED", {
      orderId: order.id,
      status: order.status,
      updatedAt: order.updatedAt,
    });
  }
  return projection;
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function finiteNumber(value: unknown, maximum: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : undefined;
}

/**
 * Treat persisted projections as untrusted input even though only Functions
 * should write them. Reconstructing an allowlisted object prevents a malformed
 * or manually edited record from smuggling customer-private fields into an
 * operator response.
 */
export function parseOperationalOrderProjection(
  value: unknown,
  expectedOrderId?: string,
): OperationalOrderProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const orderId = text(source.orderId, 128);
  const customerId = text(source.customerId, 128);
  const restaurantId = text(source.restaurantId, 128);
  const restaurantName = text(source.restaurantName, 160);
  const riderId = source.riderId === undefined ? undefined : text(source.riderId, 128);
  const status = source.status;
  const paymentMethod = source.paymentMethod;
  const paymentState = source.paymentState;
  const total = finiteNumber(source.total, 1_000_000_000);
  const itemCount = finiteNumber(source.itemCount, 100_000);
  const createdAt = finiteNumber(source.createdAt, Number.MAX_SAFE_INTEGER);
  const updatedAt = finiteNumber(source.updatedAt, Number.MAX_SAFE_INTEGER);
  const active = source.active;
  if (
    source.version !== 1 || source.source !== "functions" || !orderId ||
    (expectedOrderId !== undefined && orderId !== expectedOrderId) ||
    !customerId || !restaurantId || !restaurantName ||
    (source.riderId !== undefined && !riderId) ||
    !isLegacyOrderStatus(status) || typeof active !== "boolean" ||
    active !== isOperationalOrderActive(status) ||
    source.currency !== "INR" ||
    !["cod", "upi", "card"].includes(String(paymentMethod)) ||
    !["cash_due", "pending", "authorized", "paid", "refunded", "failed"].includes(String(paymentState)) ||
    total === undefined || itemCount === undefined || !Number.isInteger(itemCount) ||
    createdAt === undefined || updatedAt === undefined || !Number.isInteger(createdAt) || !Number.isInteger(updatedAt)
  ) return null;

  const activeSortKey = text(source.activeSortKey, 300);
  const recentSortKey = text(source.recentSortKey, 300);
  const terminalAt = source.terminalAt === undefined
    ? undefined
    : finiteNumber(source.terminalAt, Number.MAX_SAFE_INTEGER);
  const riderArrivalVerified = source.riderArrivalVerified;
  const riderArrivedRestaurantAt = source.riderArrivedRestaurantAt === undefined
    ? undefined
    : finiteNumber(source.riderArrivedRestaurantAt, Number.MAX_SAFE_INTEGER);
  if ((riderArrivalVerified === true) !== (riderArrivedRestaurantAt !== undefined) ||
    (riderArrivedRestaurantAt !== undefined && !Number.isInteger(riderArrivedRestaurantAt))) return null;
  if (active) {
    if (!activeSortKey?.startsWith("active:") || recentSortKey || terminalAt !== undefined) return null;
  } else if (!recentSortKey?.startsWith("recent:") || activeSortKey || terminalAt === undefined || !Number.isInteger(terminalAt)) {
    return null;
  }

  return {
    version: 1,
    source: "functions",
    orderId,
    customerId,
    restaurantId,
    restaurantName,
    ...(riderId ? {riderId} : {}),
    ...(riderArrivalVerified === true && riderArrivedRestaurantAt !== undefined
      ? {riderArrivalVerified: true as const, riderArrivedRestaurantAt}
      : {}),
    status,
    active,
    ...(active ? {activeSortKey} : {recentSortKey, terminalAt}),
    paymentMethod: paymentMethod as OperationalOrderProjection["paymentMethod"],
    paymentState: paymentState as OperationalOrderProjection["paymentState"],
    total,
    currency: "INR",
    itemCount,
    createdAt,
    updatedAt,
  };
}

function projectionDocs(docs: readonly {id: string; data(): unknown}[]): OperationalOrderProjection[] {
  return docs
    .map((doc) => parseOperationalOrderProjection(doc.data(), doc.id))
    .filter((entry): entry is OperationalOrderProjection => entry !== null);
}

/**
 * Bounded query foundation for a future callable/admin API. Do not expose the
 * private collection directly to clients. `active`+`updatedAt` is a real
 * composite index here (see firestore.indexes.json) - the `activeSortKey`
 * lexicographic-range trick this replaced is no longer needed for the query,
 * though the field itself stays in the stored projection since
 * parseOperationalOrderProjection still validates its presence.
 */
export async function listActiveOperationalOrders(limit = 100): Promise<OperationalOrderProjection[]> {
  const snapshot = await operationalOrdersCollectionRef()
    .where("active", "==", true)
    .orderBy("updatedAt", "desc")
    .limit(pageSize(limit))
    .get();
  return projectionDocs(snapshot.docs);
}

export async function listRecentOperationalOrders(limit = 100): Promise<OperationalOrderProjection[]> {
  const snapshot = await operationalOrdersCollectionRef()
    .where("active", "==", false)
    .orderBy("updatedAt", "desc")
    .limit(pageSize(limit))
    .get();
  return projectionDocs(snapshot.docs);
}
