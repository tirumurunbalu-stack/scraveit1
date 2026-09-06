import {haversineKm} from "./order";
import {
  MAX_GEOFENCE_ACCURACY_METERS,
  MAX_TRACKING_AGE_MS,
  MAX_TRACKING_FUTURE_SKEW_MS,
} from "./tracking";
import type {SavrivoOrder} from "../types";

export const RESTAURANT_ARRIVAL_RADIUS_METERS = 100;

export const RESTAURANT_ARRIVAL_ORDER_STATUSES = new Set<SavrivoOrder["status"]>([
  "Accepted",
  "Preparing",
  "Ready for pickup",
  "Assigned",
]);

export interface RiderRestaurantArrivalEvidence {
  distanceMeters: number;
  accuracyMeters: number;
  trackingUpdatedAt: number;
}

export type RiderRestaurantArrivalEvidenceSource =
  | "server_verified_pickup_tracking"
  | "server_verified_pickup_presence";

export type RiderRestaurantArrivalRejection =
  | "ORDER_NOT_ASSIGNED_TO_RIDER"
  | "ORDER_NOT_AWAITING_RESTAURANT_ARRIVAL"
  | "RESTAURANT_LOCATION_INVALID"
  | "PICKUP_TRACKING_INVALID"
  | "PICKUP_TRACKING_STALE"
  | "RIDER_NOT_AT_RESTAURANT";

export type RiderRestaurantArrivalDecision =
  | {ok: true; evidence: RiderRestaurantArrivalEvidence; source: RiderRestaurantArrivalEvidenceSource}
  | {ok: false; reason: RiderRestaurantArrivalRejection};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function verifyLocationEvidence(
  restaurantLat: number,
  restaurantLng: number,
  lat: number | null,
  lng: number | null,
  accuracy: number | null,
  updatedAt: number | null,
  now: number,
): RiderRestaurantArrivalDecision {
  if (
    lat === null || lat < -90 || lat > 90 ||
    lng === null || lng < -180 || lng > 180 ||
    accuracy === null || accuracy < 0 || accuracy > MAX_GEOFENCE_ACCURACY_METERS ||
    updatedAt === null || !Number.isSafeInteger(updatedAt) || updatedAt <= 0
  ) {
    return {ok: false, reason: "PICKUP_TRACKING_INVALID"};
  }
  if (updatedAt < now - MAX_TRACKING_AGE_MS || updatedAt > now + MAX_TRACKING_FUTURE_SKEW_MS) {
    return {ok: false, reason: "PICKUP_TRACKING_STALE"};
  }
  const distanceMeters = haversineKm(
    {lat, lng},
    {lat: restaurantLat, lng: restaurantLng},
  ) * 1000;
  if (distanceMeters + accuracy > RESTAURANT_ARRIVAL_RADIUS_METERS) {
    return {ok: false, reason: "RIDER_NOT_AT_RESTAURANT"};
  }
  return {
    ok: true,
    evidence: {
      distanceMeters: Math.round(distanceMeters * 10) / 10,
      accuracyMeters: Math.round(accuracy * 10) / 10,
      trackingUpdatedAt: updatedAt,
    },
    source: "server_verified_pickup_tracking",
  };
}

/**
 * Pure server-side verifier for pickup arrival. The tracking coordinates are
 * used only to make this decision and are deliberately absent from the
 * returned evidence, restaurant projection and admin projection.
 */
export function verifyRiderRestaurantArrival(
  order: SavrivoOrder,
  authenticatedRiderId: string,
  trackingValue: unknown,
  now: number,
  riderPresenceValue?: unknown,
): RiderRestaurantArrivalDecision {
  if (!authenticatedRiderId || order.riderId !== authenticatedRiderId) {
    return {ok: false, reason: "ORDER_NOT_ASSIGNED_TO_RIDER"};
  }
  if (!RESTAURANT_ARRIVAL_ORDER_STATUSES.has(order.status)) {
    return {ok: false, reason: "ORDER_NOT_AWAITING_RESTAURANT_ARRIVAL"};
  }
  const restaurantLat = finite(order.restaurantLocation?.lat);
  const restaurantLng = finite(order.restaurantLocation?.lng);
  if (restaurantLat === null || restaurantLat < -90 || restaurantLat > 90 ||
    restaurantLng === null || restaurantLng < -180 || restaurantLng > 180) {
    return {ok: false, reason: "RESTAURANT_LOCATION_INVALID"};
  }
  let trackingDecision: RiderRestaurantArrivalDecision = {ok: false, reason: "PICKUP_TRACKING_INVALID"};
  if (trackingValue && typeof trackingValue === "object" && !Array.isArray(trackingValue)) {
    const tracking = trackingValue as Record<string, unknown>;
    if (
      String(tracking.orderId ?? "") === order.id &&
      String(tracking.customerId ?? "") === order.customerId &&
      String(tracking.riderId ?? "") === authenticatedRiderId &&
      tracking.phase === "pickup" && tracking.status === "live"
    ) {
      trackingDecision = verifyLocationEvidence(
        restaurantLat,
        restaurantLng,
        finite(tracking.lat),
        finite(tracking.lng),
        finite(tracking.accuracy),
        finite(tracking.updatedAt),
        now,
      );
    }
  }
  if (trackingDecision.ok) return trackingDecision;

  if (riderPresenceValue && typeof riderPresenceValue === "object" && !Array.isArray(riderPresenceValue)) {
    const presence = riderPresenceValue as Record<string, unknown>;
    if (
      presence.online === true &&
      String(presence.riderId ?? "") === authenticatedRiderId &&
      String(presence.activeOrderId ?? "") === order.id
    ) {
      const presenceDecision = verifyLocationEvidence(
        restaurantLat,
        restaurantLng,
        finite(presence.lat),
        finite(presence.lng),
        finite(presence.accuracy),
        finite(presence.updatedAt),
        now,
      );
      if (presenceDecision.ok) {
        return {
          ...presenceDecision,
          source: "server_verified_pickup_presence",
        };
      }
    }
  }
  return trackingDecision;
}
