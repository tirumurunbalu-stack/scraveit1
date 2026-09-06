import type {DispatchPolicySnapshot, RiderCandidate} from "../types";

export type DispatchMode = "sequential" | "waves";

/**
 * Versioned server-owned rider-dispatch policy.
 *
 * Defaults intentionally preserve the currently deployed nearest-rider flow.
 * Operations can enable progressive waves from the backend without requiring
 * an Android release, while every in-flight queue keeps its own snapshot.
 */
export interface DispatchPolicy extends DispatchPolicySnapshot {
  mode: DispatchMode;
}

export const DEFAULT_DISPATCH_POLICY: Readonly<DispatchPolicy> = Object.freeze({
  version: 1,
  mode: "sequential",
  initialRadiusKm: 50,
  radiusExpansionKm: 0,
  maxRadiusKm: 50,
  offerTimeoutSeconds: 180,
  ridersPerWave: 1,
  maxWaves: 20,
  maxCandidates: 20,
  presenceFreshMs: 90_000,
  maxLocationAccuracyMeters: 100,
  reofferCooldownMs: 5 * 60_000,
  fairnessLoadPenaltyKm: 5,
  claimLeaseSeconds: 60,
});

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Math.round(boundedNumber(value, fallback, minimum, maximum));
}

/** Converts untrusted RTDB configuration into a safe complete policy. */
export function normalizeDispatchPolicy(value: unknown): DispatchPolicy {
  const input = record(value);
  const mode: DispatchMode = input.mode === "waves" ? "waves" : "sequential";
  const maxRadiusKm = boundedNumber(input.maxRadiusKm, DEFAULT_DISPATCH_POLICY.maxRadiusKm, 1, 100);
  const initialRadiusKm = Math.min(maxRadiusKm,
    boundedNumber(input.initialRadiusKm, DEFAULT_DISPATCH_POLICY.initialRadiusKm, 0.25, 100));
  const maxCandidates = boundedInteger(input.maxCandidates, DEFAULT_DISPATCH_POLICY.maxCandidates, 1, 100);
  return {
    version: 1,
    mode,
    initialRadiusKm,
    radiusExpansionKm: mode === "waves"
      ? boundedNumber(input.radiusExpansionKm, 2, 0.25, 50)
      : 0,
    maxRadiusKm,
    offerTimeoutSeconds: boundedInteger(
      input.offerTimeoutSeconds, DEFAULT_DISPATCH_POLICY.offerTimeoutSeconds, 15, 300,
    ),
    ridersPerWave: mode === "waves"
      ? Math.min(maxCandidates, boundedInteger(input.ridersPerWave, 3, 1, 10))
      : 1,
    maxWaves: boundedInteger(input.maxWaves, DEFAULT_DISPATCH_POLICY.maxWaves, 1, 50),
    maxCandidates,
    presenceFreshMs: boundedInteger(input.presenceFreshMs, DEFAULT_DISPATCH_POLICY.presenceFreshMs, 15_000, 300_000),
    maxLocationAccuracyMeters: boundedNumber(
      input.maxLocationAccuracyMeters, DEFAULT_DISPATCH_POLICY.maxLocationAccuracyMeters, 10, 500,
    ),
    reofferCooldownMs: boundedInteger(
      input.reofferCooldownMs, DEFAULT_DISPATCH_POLICY.reofferCooldownMs, 30_000, 24 * 60 * 60_000,
    ),
    fairnessLoadPenaltyKm: boundedNumber(
      input.fairnessLoadPenaltyKm, DEFAULT_DISPATCH_POLICY.fairnessLoadPenaltyKm, 0, 100,
    ),
    claimLeaseSeconds: boundedInteger(
      input.claimLeaseSeconds, DEFAULT_DISPATCH_POLICY.claimLeaseSeconds, 15, 300,
    ),
  };
}

export interface DispatchWave {
  wave: number;
  radiusKm: number;
  candidates: RiderCandidate[];
}

export function radiusForWave(policy: DispatchPolicy, wave: number): number {
  if (policy.mode === "sequential") return policy.maxRadiusKm;
  return Math.min(policy.maxRadiusKm, policy.initialRadiusKm + Math.max(0, wave) * policy.radiusExpansionKm);
}

/**
 * Returns the next non-empty progressive wave. Riders already attempted for
 * this order are never selected. A caller can persist the returned wave and
 * policy snapshot so retries are deterministic even if operations later edits
 * the global policy.
 */
export function findNextDispatchWave(
  candidates: readonly RiderCandidate[],
  attemptedRiders: Readonly<Record<string, number>>,
  policy: DispatchPolicy,
  startingWave: number,
): DispatchWave | null {
  const remaining = candidates.filter((candidate) =>
    !Object.prototype.hasOwnProperty.call(attemptedRiders, candidate.riderId) &&
    Number.isFinite(candidate.distanceKm) && candidate.distanceKm >= 0 && candidate.distanceKm <= policy.maxRadiusKm,
  );
  if (!remaining.length) return null;

  for (let wave = Math.max(0, startingWave); wave < policy.maxWaves; wave++) {
    const radiusKm = radiusForWave(policy, wave);
    const selected = remaining.filter((candidate) => candidate.distanceKm <= radiusKm)
      .slice(0, policy.ridersPerWave);
    if (selected.length) return {wave, radiusKm, candidates: selected};
    if (radiusKm >= policy.maxRadiusKm) return null;
  }
  return null;
}
