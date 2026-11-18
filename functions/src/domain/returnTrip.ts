/**
 * Return-trip pay for far drops (founder 18 Nov 2026, after delivery partners said
 * other apps pay ₹100+ for Menakuru while we paid about ₹50).
 *
 * Like the long-distance return payout other delivery apps give, a drop far away
 * from every store means the delivery partner rides back empty before the next
 * order. The ride back is measured to the NEAREST store (any store, not only the
 * one that cooked this order), so it works in every town without fixed area
 * prices: a customer next to some other store pays nothing extra, and when a
 * store opens near a far area its return pay disappears by itself.
 *
 * fee = perKm × max(0, km from drop to nearest store − freeKm), rounded to the paisa.
 * The customer pays it inside the delivery fee, and the delivery partner gets all
 * of it (delivery partner pay = bill delivery fee).
 */
import {haversineKm} from "./order";

export interface ReturnTripPolicy {
  /** Straight-line km from the drop to the nearest store that is free (in-town). */
  readonly freeKm: number;
  /** Rupees per straight-line km beyond freeKm. 0 = switched off. */
  readonly perKm: number;
}

export interface StorePoint {
  readonly lat: number;
  readonly lng: number;
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Reads settings/customer: returnTripPerKm (₹, 0/missing = off) and returnTripFreeKm (default 2 km). */
export function returnTripPolicy(settings: Record<string, unknown>): ReturnTripPolicy {
  return {
    freeKm: Math.max(0, finite(settings.returnTripFreeKm, 2)),
    perKm: Math.max(0, Math.min(50, finite(settings.returnTripPerKm, 0))),
  };
}

/** Straight-line km from the drop to the nearest store, or null when no store has a location. */
export function nearestStoreKm(drop: StorePoint, stores: readonly StorePoint[]): number | null {
  let best: number | null = null;
  for (const store of stores) {
    if (!Number.isFinite(store.lat) || !Number.isFinite(store.lng)) continue;
    if (store.lat === 0 && store.lng === 0) continue;
    const km = haversineKm(drop, store);
    if (best === null || km < best) best = km;
  }
  return best;
}

/**
 * roadFactor = this order's road km ÷ straight km, so the ride back is in road km too
 * (founder 18 Nov: road km like Swiggy/Zomato). When the cooking store is the nearest,
 * the ride back equals the road km of the order. km is rounded to 0.1 and the fee to
 * the paisa: every 0.1 km = ₹0.50 at ₹5/km.
 */
export function returnTripFee(
  drop: StorePoint,
  stores: readonly StorePoint[],
  policy: ReturnTripPolicy,
  roadFactor = 1,
): {km: number; fee: number} {
  if (policy.perKm <= 0) return {km: 0, fee: 0};
  const nearest = nearestStoreKm(drop, stores);
  if (nearest === null) return {km: 0, fee: 0};
  const factor = Number.isFinite(roadFactor) && roadFactor >= 1 ? roadFactor : 1;
  const km = Math.round(Math.max(0, nearest * factor - policy.freeKm) * 10) / 10;
  return {km, fee: Math.round(policy.perKm * km * 100) / 100};
}
