import {describe, expect, it} from "vitest";
import {
  RIDER_DISPATCH_ELIGIBILITY_MAX_AGE_MS,
  deriveRiderDispatchEligibility,
  isRiderDispatchEligibilityProjectionUsable,
} from "../src/domain/riderEligibility";

const now = 1_800_000_000_000;

describe("rider dispatch eligibility projection", () => {
  it("derives the same approved, unblocked, idle eligibility used by dispatch", () => {
    expect(deriveRiderDispatchEligibility(
      " rider-1 ",
      {status: "approved", fullName: "  Rider One  "},
      {},
      {},
      now,
    )).toEqual({
      version: 1,
      riderId: "rider-1",
      riderName: "Rider One",
      approved: true,
      codBlocked: false,
      orderBlocked: false,
      activeLoad: 0,
      workloadEligible: true,
      eligible: true,
      updatedAt: now,
    });
  });

  it("preserves the safe one-next-pickup rule only after doorstep arrival", () => {
    const arrived = deriveRiderDispatchEligibility(
      "rider-1", {status: "approved"}, {},
      {current: {status: "active", orderStatus: "Arrived", phase: "arrived"}}, now,
    );
    expect(arrived.activeLoad).toBe(1);
    expect(arrived.workloadEligible).toBe(true);
    expect(arrived.eligible).toBe(true);

    const delivering = deriveRiderDispatchEligibility(
      "rider-1", {status: "approved"}, {},
      {current: {status: "active", orderStatus: "Out for delivery", phase: "delivering"}}, now,
    );
    expect(delivering.activeLoad).toBe(1);
    expect(delivering.workloadEligible).toBe(false);
    expect(delivering.eligible).toBe(false);
  });

  it("blocks unapproved riders and either authoritative wallet hold", () => {
    expect(deriveRiderDispatchEligibility("rider-1", {status: "pending"}, {}, {}, now).eligible).toBe(false);
    expect(deriveRiderDispatchEligibility(
      "rider-1", {status: "approved"}, {codBlocked: true}, {}, now,
    ).eligible).toBe(false);
    expect(deriveRiderDispatchEligibility(
      "rider-1", {status: "approved"}, {orderBlocked: true}, {}, now,
    ).eligible).toBe(false);
  });

  it("counts all current active-job representations without changing legacy behavior", () => {
    const projection = deriveRiderDispatchEligibility("rider-1", {status: "approved"}, {}, {
      assigned: {orderStatus: "Assigned"},
      handed: {orderStatus: "Handed to rider"},
      delivered: {orderStatus: "Delivered"},
      legacy: {status: "active"},
    }, now);
    expect(projection.activeLoad).toBe(3);
    expect(projection.workloadEligible).toBe(false);
  });

  it("accepts only a fresh, internally consistent record for the expected rider", () => {
    const projection = deriveRiderDispatchEligibility("rider-1", {status: "approved"}, {}, {}, now);
    expect(isRiderDispatchEligibilityProjectionUsable(projection, "rider-1", now)).toBe(true);
    expect(isRiderDispatchEligibilityProjectionUsable(projection, "rider-2", now)).toBe(false);
    expect(isRiderDispatchEligibilityProjectionUsable({...projection, version: 2}, "rider-1", now)).toBe(false);
    expect(isRiderDispatchEligibilityProjectionUsable({...projection, eligible: false}, "rider-1", now)).toBe(false);
  });

  it("falls back for expired, future-dated, or malformed projection data", () => {
    const projection = deriveRiderDispatchEligibility("rider-1", {status: "approved"}, {}, {}, now);
    expect(isRiderDispatchEligibilityProjectionUsable(
      {...projection, updatedAt: now - RIDER_DISPATCH_ELIGIBILITY_MAX_AGE_MS - 1}, "rider-1", now,
    )).toBe(false);
    expect(isRiderDispatchEligibilityProjectionUsable({...projection, updatedAt: now + 1}, "rider-1", now)).toBe(false);
    expect(isRiderDispatchEligibilityProjectionUsable({...projection, activeLoad: -1}, "rider-1", now)).toBe(false);
    expect(isRiderDispatchEligibilityProjectionUsable({...projection, activeLoad: "0"}, "rider-1", now)).toBe(false);
    expect(isRiderDispatchEligibilityProjectionUsable(null, "rider-1", now)).toBe(false);
  });
});
