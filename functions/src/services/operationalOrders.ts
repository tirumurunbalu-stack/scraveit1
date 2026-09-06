import {logger} from "firebase-functions";
import {db} from "../admin";
import {ROOT} from "../config";
import {
  buildOperationalOrderProjection,
  isOperationalOrderActive,
  shouldApplyOperationalOrderProjection,
  type OperationalOrderProjection,
} from "../domain/operationalOrders";
import {isLegacyOrderStatus} from "../domain/lifecycle";
import type {SavrivoOrder} from "../types";

export const OPERATIONAL_ORDERS_ROOT = `${ROOT}/private/operations/orders`;
export const OPERATIONAL_ORDERS_MAX_PAGE = 250;

function pageSize(value: unknown): number {
  const size = Number(value);
  return Number.isInteger(size) ? Math.max(1, Math.min(OPERATIONAL_ORDERS_MAX_PAGE, size)) : 100;
}

export async function reconcileOperationalOrderProjection(
  order: SavrivoOrder,
): Promise<OperationalOrderProjection> {
  const next = buildOperationalOrderProjection(order);
  const result = await db.ref(`${OPERATIONAL_ORDERS_ROOT}/${order.id}`).transaction(
    (current: OperationalOrderProjection | null) =>
      shouldApplyOperationalOrderProjection(current, next) ? next : undefined,
    undefined,
    false,
  );
  if (!result.committed) {
    logger.info("STALE_OPERATIONAL_ORDER_PROJECTION_IGNORED", {
      orderId: order.id,
      status: order.status,
      updatedAt: order.updatedAt,
    });
  }
  return (result.snapshot.val() as OperationalOrderProjection | null) ?? next;
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

function projectionValues(value: unknown): OperationalOrderProjection[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .map(([orderId, entry]) => parseOperationalOrderProjection(entry, orderId))
    .filter((entry): entry is OperationalOrderProjection => entry !== null);
}

/**
 * Bounded query foundation for a future callable/admin API. Do not expose the
 * private node directly to clients. Production adoption requires the matching
 * `.indexOn` entries listed in the rollout report.
 */
export async function listActiveOperationalOrders(limit = 100): Promise<OperationalOrderProjection[]> {
  const snapshot = await db.ref(OPERATIONAL_ORDERS_ROOT)
    .orderByChild("activeSortKey")
    .startAt("active:")
    .endAt("active:\uf8ff")
    .limitToLast(pageSize(limit))
    .get();
  return projectionValues(snapshot.val()).filter((entry) => entry.active).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listRecentOperationalOrders(limit = 100): Promise<OperationalOrderProjection[]> {
  const snapshot = await db.ref(OPERATIONAL_ORDERS_ROOT)
    .orderByChild("recentSortKey")
    .startAt("recent:")
    .endAt("recent:\uf8ff")
    .limitToLast(pageSize(limit))
    .get();
  return projectionValues(snapshot.val()).filter((entry) => !entry.active).sort((a, b) => b.updatedAt - a.updatedAt);
}
