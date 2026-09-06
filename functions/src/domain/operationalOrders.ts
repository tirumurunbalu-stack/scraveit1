import type {OrderStatus, SavrivoOrder} from "../types";

export const OPERATIONAL_ORDER_PROJECTION_VERSION = 1 as const;

export interface OperationalOrderProjection {
  version: typeof OPERATIONAL_ORDER_PROJECTION_VERSION;
  source: "functions";
  orderId: string;
  customerId: string;
  restaurantId: string;
  restaurantName: string;
  riderId?: string;
  /** Privacy-safe server proof marker; coordinates remain in private tracking. */
  riderArrivalVerified?: true;
  riderArrivedRestaurantAt?: number;
  status: OrderStatus;
  active: boolean;
  activeSortKey?: string;
  recentSortKey?: string;
  paymentMethod: SavrivoOrder["paymentMethod"];
  paymentState: SavrivoOrder["paymentState"];
  total: number;
  currency: "INR";
  itemCount: number;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
}

const STATUS_RANK: Record<OrderStatus, number> = {
  "Order placed": 0,
  "Accepted": 1,
  "Preparing": 2,
  "Ready for pickup": 3,
  "Assigned": 4,
  "Handed to rider": 5,
  "Out for delivery": 6,
  "Near you": 7,
  "Arrived": 8,
  "Delivered": 9,
  "Cancelled": 9,
};

export function isOperationalOrderActive(status: OrderStatus): boolean {
  return status !== "Delivered" && status !== "Cancelled";
}

function sortTimestamp(value: unknown): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.trunc(timestamp) : 0;
}

function sortKey(lane: "active" | "recent", timestamp: number, orderId: string): string {
  return `${lane}:${String(timestamp).padStart(13, "0")}:${orderId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128)}`;
}

/**
 * Privacy-minimized current operational head. It intentionally excludes
 * addresses, phone numbers, item details, notes, OTPs and payment secrets.
 */
export function buildOperationalOrderProjection(order: SavrivoOrder): OperationalOrderProjection {
  const active = isOperationalOrderActive(order.status);
  const updatedAt = sortTimestamp(order.updatedAt);
  return {
    version: OPERATIONAL_ORDER_PROJECTION_VERSION,
    source: "functions",
    orderId: order.id,
    customerId: order.customerId,
    restaurantId: order.restaurantId,
    restaurantName: String(order.restaurant ?? "").trim().slice(0, 160),
    ...(order.riderId ? {riderId: String(order.riderId).slice(0, 128)} : {}),
    status: order.status,
    active,
    ...(active
      ? {activeSortKey: sortKey("active", updatedAt, order.id)}
      : {
        recentSortKey: sortKey("recent", updatedAt, order.id),
        terminalAt: updatedAt,
      }),
    paymentMethod: order.paymentMethod,
    paymentState: order.paymentState,
    total: Number(order.total),
    currency: "INR",
    itemCount: order.items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0),
    createdAt: sortTimestamp(order.createdAt),
    updatedAt,
  };
}

/** Reject out-of-order RTDB trigger retries without rewriting canonical data. */
export function shouldApplyOperationalOrderProjection(
  current: OperationalOrderProjection | null,
  next: OperationalOrderProjection,
): boolean {
  if (!current) return true;
  if (current.orderId !== next.orderId || current.customerId !== next.customerId) return false;
  if (next.updatedAt !== current.updatedAt) return next.updatedAt > current.updatedAt;
  if (next.status === current.status) return true;
  return (STATUS_RANK[next.status] ?? -1) > (STATUS_RANK[current.status] ?? -1);
}
