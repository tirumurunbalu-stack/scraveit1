import {describe, expect, it} from "vitest";
import {
  compareSignalFreshness,
  DEFAULT_DISPATCH_POLICY,
  findNextDispatchWave,
  isUsableBackupSignal,
  normalizeDispatchPolicy,
  radiusForWave,
  STALE_SIGNAL_MAX_AGE_MS,
  waveTimeoutSeconds,
} from "../src/domain/dispatchPolicy";
import type {RiderCandidate} from "../src/types";

const candidates: RiderCandidate[] = [
  {riderId: "near", riderName: "Near", distanceKm: 0.8, activeLoad: 0, score: 0.8},
  {riderId: "middle", riderName: "Middle", distanceKm: 2.4, activeLoad: 0, score: 2.4},
  {riderId: "far", riderName: "Far", distanceKm: 6.2, activeLoad: 0, score: 6.2},
];

describe("dispatch policy", () => {
  it("keeps deployed nearest-first behavior by default", () => {
    const wave = findNextDispatchWave(candidates, {}, {...DEFAULT_DISPATCH_POLICY}, 0);
    expect(wave?.candidates.map((entry) => entry.riderId)).toEqual(["near"]);
    expect(wave?.radiusKm).toBe(50);
  });

  it("sanitizes untrusted backend configuration", () => {
    const policy = normalizeDispatchPolicy({
      mode: "waves", initialRadiusKm: -10, maxRadiusKm: 12,
      radiusExpansionKm: 1.5, ridersPerWave: 999, offerTimeoutSeconds: 1,
      presenceFreshMs: 1, maxLocationAccuracyMeters: 9999, maxCandidates: 4,
    });
    expect(policy.mode).toBe("waves");
    expect(policy.initialRadiusKm).toBe(0.25);
    expect(policy.ridersPerWave).toBe(4);
    expect(policy.offerTimeoutSeconds).toBe(15);
    expect(policy.presenceFreshMs).toBe(15_000);
    expect(policy.maxLocationAccuracyMeters).toBe(500);
  });

  it("expands radius progressively without broadcasting globally", () => {
    const policy = normalizeDispatchPolicy({
      mode: "waves", initialRadiusKm: 1, radiusExpansionKm: 2,
      maxRadiusKm: 8, ridersPerWave: 2, maxWaves: 5,
    });
    expect(radiusForWave(policy, 0)).toBe(1);
    expect(findNextDispatchWave(candidates, {}, policy, 0)?.candidates.map((entry) => entry.riderId)).toEqual(["near"]);
    expect(findNextDispatchWave(candidates, {near: 1}, policy, 1)?.candidates.map((entry) => entry.riderId)).toEqual(["middle"]);
    expect(findNextDispatchWave(candidates, {near: 1, middle: 2}, policy, 2)?.candidates.map((entry) => entry.riderId)).toEqual(["far"]);
  });

  it("never reoffers an attempted rider and stops when exhausted", () => {
    const attempted = {near: 1, middle: 2, far: 3};
    expect(findNextDispatchWave(candidates, attempted, normalizeDispatchPolicy({mode: "waves"}), 0)).toBeNull();
  });

  it("rejects candidates beyond the configured service radius", () => {
    const policy = normalizeDispatchPolicy({mode: "waves", initialRadiusKm: 1, maxRadiusKm: 3, maxWaves: 10});
    expect(findNextDispatchWave([candidates[2]!], {}, policy, 0)).toBeNull();
  });
});

describe("backup ring for Online riders with an old signal", () => {
  it("keeps a rider usable for a day after their phone went quiet, then drops them", () => {
    expect(isUsableBackupSignal(91_000)).toBe(true);
    expect(isUsableBackupSignal(STALE_SIGNAL_MAX_AGE_MS)).toBe(true);
    expect(isUsableBackupSignal(STALE_SIGNAL_MAX_AGE_MS + 1)).toBe(false);
    expect(isUsableBackupSignal(Number.NaN)).toBe(false);
  });

  it("waits 45 s only when nobody in the wave has a live signal", () => {
    expect(waveTimeoutSeconds([{staleSignal: true}], 180)).toBe(45);
    expect(waveTimeoutSeconds([{staleSignal: true}, {staleSignal: true}], 180)).toBe(45);
    expect(waveTimeoutSeconds([{staleSignal: true}, {}], 180)).toBe(180);
    expect(waveTimeoutSeconds([{}], 180)).toBe(180);
    expect(waveTimeoutSeconds([], 180)).toBe(180);
    expect(waveTimeoutSeconds([{staleSignal: true}], 30)).toBe(30);
  });

  it("tries every live rider before any old-signal rider, however near", () => {
    const riders = [
      {riderId: "near-quiet", distanceKm: 0.5, staleSignal: true},
      {riderId: "far-live", distanceKm: 9},
      {riderId: "near-live", distanceKm: 2},
    ];
    const order = [...riders].sort((a, b) => compareSignalFreshness(a, b) || a.distanceKm - b.distanceKm)
      .map((rider) => rider.riderId);
    expect(order).toEqual(["near-live", "far-live", "near-quiet"]);
  });
});
