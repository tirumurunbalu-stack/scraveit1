import {haversineKm} from "./order";
import type {GeoPoint, OrderStatus} from "../types";

export const MAX_GEOFENCE_ACCURACY_METERS = 50;
export const MAX_TRACKING_AGE_MS = 30_000;
export const MAX_TRACKING_FUTURE_SKEW_MS = 5_000;
export const MIN_CONSECUTIVE_FIX_GAP_MS = 2_000;
export const MAX_CONSECUTIVE_FIX_GAP_MS = 45_000;
const MAX_SPEED_METERS_PER_SECOND = 60;
const MOVEMENT_ALLOWANCE_METERS = 50;

export type ProximityStatus = "Near you" | "Arrived";

export interface TrackingFix extends GeoPoint {
  orderId: string;
  customerId: string;
  riderId: string;
  accuracy: number;
  updatedAt: number;
  phase: "delivery";
  status: "live";
}

export interface PendingTrackingTransition {
  status: ProximityStatus;
  evidenceEventId: string;
  qualifiedAt: number;
  distanceMeters: number;
}

export interface TrackingEvidenceRecord extends GeoPoint {
  orderId: string;
  customerId: string;
  riderId: string;
  lastEventId: string;
  lastFixAt: number;
  accuracy: number;
  distanceMeters: number;
  candidate: ProximityStatus | "";
  consecutiveFixes: number;
  lastQualifiedAt: number;
  updatedAt: number;
  pendingTransition?: PendingTrackingTransition;
  lastTransition?: {status: ProximityStatus; at: number; evidenceEventId: string};
  lastRejected?: {eventId: string; reason: "impossible_movement"; at: number};
}

export interface ProximityRequirement {
  status: ProximityStatus;
  thresholdMeters: number;
  requiredFixes: number;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTrackingFix(value: unknown, expectedOrderId: string): TrackingFix | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const lat = finite(raw.lat);
  const lng = finite(raw.lng);
  const accuracy = finite(raw.accuracy);
  const updatedAt = finite(raw.updatedAt);
  const orderId = String(raw.orderId ?? "");
  const customerId = String(raw.customerId ?? "");
  const riderId = String(raw.riderId ?? "");
  if (orderId !== expectedOrderId || !customerId || customerId.length > 128 ||
    !riderId || riderId.length > 128 || raw.phase !== "delivery" || raw.status !== "live" ||
    lat === null || lat < -90 || lat > 90 || lng === null || lng < -180 || lng > 180 ||
    accuracy === null || accuracy < 0 || accuracy > MAX_GEOFENCE_ACCURACY_METERS ||
    updatedAt === null || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) return null;
  return {orderId, customerId, riderId, lat, lng, accuracy, updatedAt, phase: "delivery", status: "live"};
}

export function isFreshMonotonicFix(fix: TrackingFix, previousClientTimestamp: number, now: number): boolean {
  return fix.updatedAt > previousClientTimestamp &&
    fix.updatedAt >= now - MAX_TRACKING_AGE_MS &&
    fix.updatedAt <= now + MAX_TRACKING_FUTURE_SKEW_MS;
}

export function proximityRequirement(status: OrderStatus, distanceMeters: number): ProximityRequirement | null {
  // A rider already inside the strict arrival geofence does not need to wait
  // for an intermediate Near-you transition before proving arrival.
  if (status === "Out for delivery" && distanceMeters <= 100) {
    return {status: "Arrived", thresholdMeters: 100, requiredFixes: 2};
  }
  if (status === "Out for delivery" && distanceMeters <= 700) {
    return {status: "Near you", thresholdMeters: 700, requiredFixes: 2};
  }
  if (status === "Near you" && distanceMeters <= 100) {
    return {status: "Arrived", thresholdMeters: 100, requiredFixes: 2};
  }
  return null;
}

export function trackingDistanceMeters(fix: TrackingFix, dropPoint: GeoPoint): number {
  return haversineKm(fix, dropPoint) * 1000;
}

export function plausibleMovement(previous: TrackingEvidenceRecord | null, fix: TrackingFix): boolean {
  if (!previous || previous.riderId !== fix.riderId || previous.orderId !== fix.orderId) return true;
  const elapsedMs = fix.updatedAt - previous.lastFixAt;
  if (elapsedMs <= 0) return false;
  if (elapsedMs > 5 * 60_000) return true;
  const travelledMeters = haversineKm(previous, fix) * 1000;
  const maximumMeters = MAX_SPEED_METERS_PER_SECOND * elapsedMs / 1000 +
    previous.accuracy + fix.accuracy + MOVEMENT_ALLOWANCE_METERS;
  return travelledMeters <= maximumMeters;
}

export interface AdvanceEvidenceInput {
  eventId: string;
  fix: TrackingFix;
  distanceMeters: number;
  requirement: ProximityRequirement | null;
  serverNow: number;
}

/** Pure transaction reducer. The pending transition survives retries/crashes. */
export function advanceTrackingEvidence(
  previous: TrackingEvidenceRecord | null,
  input: AdvanceEvidenceInput,
): TrackingEvidenceRecord | null {
  const {eventId, fix, distanceMeters, requirement, serverNow} = input;
  if (previous?.lastEventId === eventId) return previous;
  if (!plausibleMovement(previous, fix)) {
    if (!previous) return null;
    return {
      ...previous,
      lastEventId: eventId,
      updatedAt: serverNow,
      lastRejected: {eventId, reason: "impossible_movement", at: serverNow},
    };
  }

  const sameAssignment = previous?.orderId === fix.orderId && previous.riderId === fix.riderId &&
    previous.customerId === fix.customerId;
  const base: TrackingEvidenceRecord = {
    ...(sameAssignment ? previous : {}),
    orderId: fix.orderId,
    customerId: fix.customerId,
    riderId: fix.riderId,
    lastEventId: eventId,
    lastFixAt: fix.updatedAt,
    lat: fix.lat,
    lng: fix.lng,
    accuracy: fix.accuracy,
    distanceMeters,
    candidate: "",
    consecutiveFixes: 0,
    lastQualifiedAt: 0,
    updatedAt: serverNow,
  };
  if (sameAssignment && previous?.pendingTransition) {
    return {...base, pendingTransition: previous.pendingTransition};
  }
  if (!requirement) return base;

  const gap = sameAssignment ? fix.updatedAt - Number(previous?.lastQualifiedAt ?? 0) : Number.POSITIVE_INFINITY;
  const continues = sameAssignment && previous?.candidate === requirement.status &&
    gap >= MIN_CONSECUTIVE_FIX_GAP_MS && gap <= MAX_CONSECUTIVE_FIX_GAP_MS;
  const tooSoon = sameAssignment && previous?.candidate === requirement.status &&
    gap >= 0 && gap < MIN_CONSECUTIVE_FIX_GAP_MS;
  const count = tooSoon ? Number(previous?.consecutiveFixes ?? 0) :
    continues ? Number(previous?.consecutiveFixes ?? 0) + 1 : 1;
  const lastQualifiedAt = tooSoon ? Number(previous?.lastQualifiedAt ?? 0) : fix.updatedAt;
  const qualified: TrackingEvidenceRecord = {
    ...base,
    candidate: requirement.status,
    consecutiveFixes: count,
    lastQualifiedAt,
  };
  if (count >= requirement.requiredFixes) {
    qualified.pendingTransition = {
      status: requirement.status,
      evidenceEventId: eventId,
      qualifiedAt: serverNow,
      distanceMeters,
    };
  }
  return qualified;
}

export function hasReachedProximityStatus(current: OrderStatus, target: ProximityStatus): boolean {
  if (target === "Near you") return ["Near you", "Arrived", "Delivered"].includes(current);
  return ["Arrived", "Delivered"].includes(current);
}
