import {
  MAX_DISPATCH_ACCURACY_METERS,
  PRESENCE_FRESH_MS,
  RIDER_REOFFER_COOLDOWN_MS,
} from "../config";

export interface DispatchPresence {
  online?: boolean;
  updatedAt?: number;
  lat?: number;
  lng?: number;
  accuracy?: number;
  activeOrderId?: string;
}

export interface DispatchRiderJob {
  status?: string;
  orderStatus?: string;
  phase?: string;
}

export interface DispatchPresenceLimits {
  presenceFreshMs?: number;
  maxLocationAccuracyMeters?: number;
}

const ACTIVE_JOB_STATUSES = new Set([
  "Assigned",
  "Handed to rider",
  "Out for delivery",
  "Near you",
  "Arrived",
]);

export function activeDispatchJobs(jobs: Record<string, DispatchRiderJob> | null | undefined): DispatchRiderJob[] {
  return Object.values(jobs ?? {}).filter((job) =>
    job?.status === "active" || ACTIVE_JOB_STATUSES.has(String(job?.orderStatus ?? job?.status ?? "")),
  );
}

/**
 * A rider may reserve one next pickup only after reaching the current customer's
 * doorstep. This avoids unsafe multi-order driving while allowing dispatch to
 * start when the restaurant accepts instead of waiting for food readiness.
 */
export function isEarlyDispatchWorkloadEligible(
  jobs: Record<string, DispatchRiderJob> | null | undefined,
): boolean {
  const active = activeDispatchJobs(jobs);
  if (active.length === 0) return true;
  return active.length === 1 && active.every((job) =>
    job?.orderStatus === "Arrived" || job?.phase === "arrived",
  );
}

export function availabilityCityKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unknown";
}

export function isValidDispatchCoordinate(latValue: unknown, lngValue: unknown): boolean {
  const lat = Number(latValue);
  const lng = Number(lngValue);
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    !(lat === 0 && lng === 0);
}

export function isDispatchPresenceEligible(
  presence: DispatchPresence | null,
  now = Date.now(),
  limits: DispatchPresenceLimits = {},
): boolean {
  const presenceFreshMs = Number.isFinite(Number(limits.presenceFreshMs))
    ? Math.max(0, Number(limits.presenceFreshMs))
    : PRESENCE_FRESH_MS;
  const maxLocationAccuracyMeters = Number.isFinite(Number(limits.maxLocationAccuracyMeters))
    ? Math.max(0, Number(limits.maxLocationAccuracyMeters))
    : MAX_DISPATCH_ACCURACY_METERS;
  const accuracy = presence?.accuracy == null ? null : Number(presence.accuracy);
  return Boolean(
    presence?.online === true &&
    !presence.activeOrderId &&
    isValidDispatchCoordinate(presence.lat, presence.lng) &&
    (accuracy == null || (Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= maxLocationAccuracyMeters)) &&
    now - Number(presence.updatedAt ?? 0) <= presenceFreshMs,
  );
}

export function wasRecentlyOffered(
  attemptedAt: unknown,
  now = Date.now(),
  cooldownMs = RIDER_REOFFER_COOLDOWN_MS,
): boolean {
  const at = Number(attemptedAt);
  const normalizedCooldown = Number.isFinite(Number(cooldownMs)) ? Math.max(0, Number(cooldownMs)) : RIDER_REOFFER_COOLDOWN_MS;
  return Number.isFinite(at) && at > 0 && now - at < normalizedCooldown;
}

export function riderBecameDispatchEligible(
  before: DispatchPresence | null,
  after: DispatchPresence | null,
  now = Date.now(),
): boolean {
  return isDispatchPresenceEligible(after, now) && !isDispatchPresenceEligible(before, now);
}

/**
 * Decide only whether exhausted queues should be rescanned. The rescan checks
 * authoritative riderJobs, so an Arrived activeOrderId must not suppress the
 * fresh-heartbeat trigger used to reserve one safe next delivery.
 */
export function riderBecameDispatchSearchable(
  before: DispatchPresence | null,
  after: DispatchPresence | null,
  now = Date.now(),
): boolean {
  const searchable = (presence: DispatchPresence | null): DispatchPresence | null =>
    presence ? {...presence, activeOrderId: ""} : null;
  return isDispatchPresenceEligible(searchable(after), now) &&
    !isDispatchPresenceEligible(searchable(before), now);
}

/**
 * Searchability intentionally ignores the presence projection's active order.
 * The authoritative riderJobs check runs while candidates are hydrated and
 * permits only the existing safe "arrived at doorstep" early-dispatch case.
 */
export function isDispatchPresenceSearchable(
  presence: DispatchPresence | null,
  now = Date.now(),
): boolean {
  return isDispatchPresenceEligible(presence ? {...presence, activeOrderId: ""} : null, now);
}
