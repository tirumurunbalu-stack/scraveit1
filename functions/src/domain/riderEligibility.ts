import {
  activeDispatchJobs,
  isEarlyDispatchWorkloadEligible,
  type DispatchRiderJob,
} from "./dispatch";

export const RIDER_DISPATCH_ELIGIBILITY_VERSION = 1 as const;

/**
 * A projection is refreshed by source-data triggers and lazily repaired by
 * dispatch. The age limit is only a consistency safety net: rider claim still
 * revalidates profile, wallet holds and workload from their authoritative
 * records before assigning an order.
 */
export const RIDER_DISPATCH_ELIGIBILITY_MAX_AGE_MS = 30 * 60_000;

export interface RiderEligibilityProfile {
  status?: string;
  fullName?: string;
}

export interface RiderEligibilityWallet {
  codBlocked?: boolean;
  orderBlocked?: boolean;
}

export interface RiderEligibilityWorkload {
  activeCount: number;
  workloadEligible: boolean;
}

export interface RiderDispatchEligibilityProjection {
  version: typeof RIDER_DISPATCH_ELIGIBILITY_VERSION;
  riderId: string;
  riderName: string;
  approved: boolean;
  codBlocked: boolean;
  orderBlocked: boolean;
  activeLoad: number;
  workloadEligible: boolean;
  eligible: boolean;
  updatedAt: number;
}

function normalizedRiderId(value: unknown): string {
  return String(value ?? "").trim().slice(0, 128);
}

function normalizedRiderName(value: unknown): string {
  return String(value ?? "").trim().slice(0, 120);
}

/** Pure derivation from the three authoritative rider records. */
export function deriveRiderDispatchEligibility(
  riderIdValue: unknown,
  profile: RiderEligibilityProfile | null | undefined,
  wallet: RiderEligibilityWallet | null | undefined,
  jobs: Record<string, DispatchRiderJob> | null | undefined,
  updatedAtValue = Date.now(),
): RiderDispatchEligibilityProjection {
  return deriveRiderDispatchEligibilityFromWorkload(
    riderIdValue,
    profile,
    wallet,
    {
      activeCount: activeDispatchJobs(jobs).length,
      workloadEligible: isEarlyDispatchWorkloadEligible(jobs),
    },
    updatedAtValue,
  );
}

/** Pure derivation from profile/wallet plus the server-owned workload head. */
export function deriveRiderDispatchEligibilityFromWorkload(
  riderIdValue: unknown,
  profile: RiderEligibilityProfile | null | undefined,
  wallet: RiderEligibilityWallet | null | undefined,
  workload: RiderEligibilityWorkload,
  updatedAtValue = Date.now(),
): RiderDispatchEligibilityProjection {
  const riderId = normalizedRiderId(riderIdValue);
  const riderName = normalizedRiderName(profile?.fullName);
  const approved = profile?.status === "approved";
  const codBlocked = wallet?.codBlocked === true;
  const orderBlocked = wallet?.orderBlocked === true;
  const activeLoadValue = Number(workload.activeCount);
  const activeLoad = Number.isInteger(activeLoadValue) && activeLoadValue >= 0 ? activeLoadValue : 0;
  const workloadEligible = workload.workloadEligible === true;
  const updatedAt = Number(updatedAtValue);
  return {
    version: RIDER_DISPATCH_ELIGIBILITY_VERSION,
    riderId,
    riderName,
    approved,
    codBlocked,
    orderBlocked,
    activeLoad,
    workloadEligible,
    eligible: approved && !codBlocked && !orderBlocked && workloadEligible,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : 0,
  };
}

/**
 * Reject malformed, cross-rider, old-version, future-dated, or expired
 * records. Dispatch then falls back to current authoritative reads.
 */
export function isRiderDispatchEligibilityProjectionUsable(
  value: unknown,
  expectedRiderIdValue: unknown,
  nowValue = Date.now(),
  maxAgeMsValue = RIDER_DISPATCH_ELIGIBILITY_MAX_AGE_MS,
): value is RiderDispatchEligibilityProjection {
  if (!value || typeof value !== "object") return false;
  const projection = value as Partial<RiderDispatchEligibilityProjection>;
  const expectedRiderId = normalizedRiderId(expectedRiderIdValue);
  const now = Number(nowValue);
  const maxAgeMs = Number(maxAgeMsValue);
  const updatedAt = Number(projection.updatedAt);
  const activeLoad = Number(projection.activeLoad);
  if (!expectedRiderId || projection.version !== RIDER_DISPATCH_ELIGIBILITY_VERSION ||
    normalizedRiderId(projection.riderId) !== expectedRiderId) return false;
  if (typeof projection.riderName !== "string" || projection.riderName.length > 120 ||
    typeof projection.activeLoad !== "number" || typeof projection.updatedAt !== "number") return false;
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 ||
    !Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > now || now - updatedAt > maxAgeMs) return false;
  if (!Number.isInteger(activeLoad) || activeLoad < 0 ||
    typeof projection.approved !== "boolean" || typeof projection.codBlocked !== "boolean" ||
    typeof projection.orderBlocked !== "boolean" || typeof projection.workloadEligible !== "boolean" ||
    typeof projection.eligible !== "boolean") return false;
  return projection.eligible === (
    projection.approved && !projection.codBlocked && !projection.orderBlocked && projection.workloadEligible
  );
}
