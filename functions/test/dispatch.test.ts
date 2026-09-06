import {describe, expect, it} from "vitest";
import {
  availabilityCityKey,
  activeDispatchJobs,
  isEarlyDispatchWorkloadEligible,
  isDispatchPresenceEligible,
  isDispatchPresenceSearchable,
  isValidDispatchCoordinate,
  riderBecameDispatchEligible,
  riderBecameDispatchSearchable,
  wasRecentlyOffered,
} from "../src/domain/dispatch";

describe("rider dispatch eligibility", () => {
  const now = 1_000_000;
  const ready = {
    online: true,
    lat: 13.9174,
    lng: 79.8959,
    city: "Naidupeta",
    updatedAt: now,
  };

  it("normalizes the restaurant city used by the availability index", () => {
    expect(availabilityCityKey("  NaiDu Peta ")).toBe("naidu-peta");
    expect(availabilityCityKey("Naidupeta")).toBe("naidupeta");
  });

  it("recovers exhausted ready orders when a rider comes online", () => {
    expect(riderBecameDispatchEligible({...ready, online: false}, ready, now)).toBe(true);
  });

  it("recovers when an online rider returns with a fresh location", () => {
    expect(riderBecameDispatchEligible({...ready, updatedAt: now - 91_000}, ready, now)).toBe(true);
  });

  it("rescans when a finishing rider refreshes stale presence", () => {
    const finishing = {...ready, activeOrderId: "SV-ARRIVED"};
    expect(riderBecameDispatchSearchable({...finishing, updatedAt: now - 91_000}, finishing, now)).toBe(true);
  });

  it("does not rescan dispatch on every normal heartbeat", () => {
    expect(riderBecameDispatchEligible({...ready, updatedAt: now - 20_000}, ready, now)).toBe(false);
  });

  it("keeps a fresh online rider searchable for throttled recovery scans", () => {
    expect(isDispatchPresenceSearchable(ready, now)).toBe(true);
    expect(isDispatchPresenceSearchable({...ready, activeOrderId: "SV-ARRIVED"}, now)).toBe(true);
    expect(isDispatchPresenceSearchable({...ready, online: false}, now)).toBe(false);
  });

  it("rejects stale, busy, offline, and invalid presence", () => {
    expect(riderBecameDispatchEligible(null, {...ready, updatedAt: now - 91_000}, now)).toBe(false);
    expect(riderBecameDispatchEligible(null, {...ready, activeOrderId: "SV-1"}, now)).toBe(false);
    expect(riderBecameDispatchEligible(null, {...ready, online: false}, now)).toBe(false);
    expect(riderBecameDispatchEligible(null, {...ready, lat: Number.NaN}, now)).toBe(false);
  });

  it("rejects illegal, zero, and inaccurate dispatch fixes", () => {
    expect(isValidDispatchCoordinate(13.9174, 79.8959)).toBe(true);
    expect(isValidDispatchCoordinate(0, 0)).toBe(false);
    expect(isValidDispatchCoordinate(179, 13)).toBe(false);
    expect(isDispatchPresenceEligible({...ready, accuracy: 35}, now)).toBe(true);
    expect(isDispatchPresenceEligible({...ready, accuracy: 240}, now)).toBe(false);
    expect(isDispatchPresenceEligible({...ready, accuracy: 240}, now, {maxLocationAccuracyMeters: 250})).toBe(true);
    expect(isDispatchPresenceEligible({...ready, updatedAt: now - 100_000}, now, {presenceFreshMs: 120_000})).toBe(true);
  });

  it("prevents the same exhausted order from blinking back to one rider", () => {
    expect(wasRecentlyOffered(now - 30_000, now)).toBe(true);
    expect(wasRecentlyOffered(now - 301_000, now)).toBe(false);
    expect(wasRecentlyOffered(now - 30_000, now, 20_000)).toBe(false);
  });

  it("allows one next reservation only after the current rider reaches the doorstep", () => {
    expect(isEarlyDispatchWorkloadEligible({})).toBe(true);
    expect(isEarlyDispatchWorkloadEligible({one: {status: "active", orderStatus: "Arrived", phase: "arrived"}})).toBe(true);
    expect(isEarlyDispatchWorkloadEligible({one: {status: "active", orderStatus: "Out for delivery", phase: "delivery"}})).toBe(false);
    expect(isEarlyDispatchWorkloadEligible({
      one: {status: "active", orderStatus: "Arrived", phase: "arrived"},
      two: {status: "active", orderStatus: "Assigned", phase: "pickup"},
    })).toBe(false);
    expect(activeDispatchJobs({one: {status: "active", orderStatus: "Assigned"}, done: {status: "completed"}})).toHaveLength(1);
  });
});
