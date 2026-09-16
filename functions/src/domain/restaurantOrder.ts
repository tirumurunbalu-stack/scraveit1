import {stripPrivateOrderFields} from "./orderSecurity";
import type {OrderStatus, SavrivoOrder} from "../types";

export interface RiderArrivalVerification {
  verified: true;
  verifiedAt: number;
  distanceMeters: number;
  accuracyMeters: number;
  source: string;
}

export type RestaurantOrderProjection = Omit<SavrivoOrder, "customerPhone" | "address"> & {
  address: {label: string; area: string; city?: string};
  riderArrivalVerified?: true;
  riderArrivedRestaurantAt?: number;
  riderArrivalVerification?: RiderArrivalVerification;
};

/**
 * Restaurant operations need the order, not a customer's phone or drop pin.
 *
 * Verified rider restaurant arrival is written directly onto this projection
 * by markRiderArrivedRestaurant and never lives on the canonical order. A
 * rebuild driven purely by `order` must carry it forward for the same rider
 * assignment, or a later kitchen status update (e.g. Preparing -> Ready for
 * pickup, which also auto-promotes to Assigned) would silently erase an
 * arrival the rider already verified before the kitchen marked it ready.
 */
export function buildRestaurantOrderProjection(
  order: SavrivoOrder,
  existing?: RestaurantOrderProjection | null,
): RestaurantOrderProjection {
  const clean = stripPrivateOrderFields(order);
  const {customerPhone: _phone, address, ...rest} = clean;
  const projection: RestaurantOrderProjection = {
    ...rest,
    address: {
      label: address.label,
      area: address.area,
      ...(address.city ? {city: address.city} : {}),
    },
  };
  if (existing && existing.riderId && order.riderId && existing.riderId === order.riderId &&
      existing.riderArrivalVerified === true) {
    projection.riderArrivalVerified = true;
    if (existing.riderArrivedRestaurantAt !== undefined) {
      projection.riderArrivedRestaurantAt = existing.riderArrivedRestaurantAt;
    }
    if (existing.riderArrivalVerification !== undefined) {
      projection.riderArrivalVerification = existing.riderArrivalVerification;
    }
  }
  return projection;
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
