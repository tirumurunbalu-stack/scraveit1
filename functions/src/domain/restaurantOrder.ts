import {stripPrivateOrderFields} from "./orderSecurity";
import type {OrderStatus, SavrivoOrder} from "../types";

export type RestaurantOrderProjection = Omit<SavrivoOrder, "customerPhone" | "address"> & {
  address: {label: string; area: string; city?: string};
};

/** Restaurant operations need the order, not a customer's phone or drop pin. */
export function buildRestaurantOrderProjection(order: SavrivoOrder): RestaurantOrderProjection {
  const clean = stripPrivateOrderFields(order);
  const {customerPhone: _phone, address, ...rest} = clean;
  return {
    ...rest,
    address: {
      label: address.label,
      area: address.area,
      ...(address.city ? {city: address.city} : {}),
    },
  };
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

/**
 * Realtime Database triggers are at-least-once and may finish out of order.
 * Never let an older order event overwrite a newer restaurant projection.
 */
export function shouldApplyRestaurantOrderProjection(
  current: RestaurantOrderProjection | null,
  next: RestaurantOrderProjection,
): boolean {
  if (!current) return true;
  if (current.id !== next.id || current.customerId !== next.customerId ||
      current.restaurantId !== next.restaurantId) return false;
  const currentAt = Number(current.updatedAt ?? 0);
  const nextAt = Number(next.updatedAt ?? 0);
  if (nextAt !== currentAt) return nextAt > currentAt;
  if (current.status === next.status) return true;
  return (STATUS_RANK[next.status] ?? -1) > (STATUS_RANK[current.status] ?? -1);
}
