import {describe, expect, it} from "vitest";
import {
  advanceTrackingEvidence,
  isFreshMonotonicFix,
  normalizeTrackingFix,
  proximityRequirement,
  type TrackingEvidenceRecord,
  type TrackingFix,
} from "../src/domain/tracking";

function fix(updatedAt: number, lat = 13.9, lng = 79.88): TrackingFix {
  return {
    orderId: "SV-TRACK",
    customerId: "customer-1",
    riderId: "rider-1",
    lat,
    lng,
    accuracy: 12,
    updatedAt,
    phase: "delivery",
    status: "live",
  };
}

function advance(
  previous: TrackingEvidenceRecord | null,
  eventId: string,
  currentFix: TrackingFix,
  status: "Out for delivery" | "Near you",
  distanceMeters: number,
): TrackingEvidenceRecord {
  return advanceTrackingEvidence(previous, {
    eventId,
    fix: currentFix,
    distanceMeters,
    requirement: proximityRequirement(status, distanceMeters),
    serverNow: currentFix.updatedAt + 100,
  })!;
}

describe("server tracking evidence", () => {
  it("rejects malformed, inaccurate, stale, replayed, and future fixes", () => {
    expect(normalizeTrackingFix({...fix(1_000_000), accuracy: 51}, "SV-TRACK")).toBeNull();
    expect(normalizeTrackingFix({...fix(1_000_000), riderId: ""}, "SV-TRACK")).toBeNull();
    const valid = normalizeTrackingFix(fix(1_000_000), "SV-TRACK")!;
    expect(isFreshMonotonicFix(valid, 999_999, 1_010_000)).toBe(true);
    expect(isFreshMonotonicFix(valid, 1_000_000, 1_010_000)).toBe(false);
    expect(isFreshMonotonicFix(valid, 0, 1_031_000)).toBe(false);
    expect(isFreshMonotonicFix(valid, 0, 994_999)).toBe(false);
  });

  it("requires two separated server-qualified fixes before Near you", () => {
    const one = advance(null, "event-1", fix(1_000_000), "Out for delivery", 650);
    expect(one.consecutiveFixes).toBe(1);
    expect(one.pendingTransition).toBeUndefined();

    const tooSoon = advance(one, "event-2", fix(1_001_000, 13.90001), "Out for delivery", 640);
    expect(tooSoon.consecutiveFixes).toBe(1);
    const two = advance(tooSoon, "event-3", fix(1_003_000, 13.90002), "Out for delivery", 630);
    expect(two.consecutiveFixes).toBe(2);
    expect(two.pendingTransition).toMatchObject({status: "Near you", evidenceEventId: "event-3"});
    expect(advanceTrackingEvidence(two, {
      eventId: "event-3",
      fix: fix(1_003_000, 13.90002),
      distanceMeters: 630,
      requirement: proximityRequirement("Out for delivery", 630),
      serverNow: 1_003_200,
    })).toBe(two);
  });

  it("requires two consecutive fixes inside 100 metres before Arrived", () => {
    const one = advance(null, "a-1", fix(2_000_000), "Near you", 90);
    const two = advance(one, "a-2", fix(2_002_500, 13.90001), "Near you", 80);
    expect(one.pendingTransition).toBeUndefined();
    expect(two.pendingTransition).toMatchObject({status: "Arrived", evidenceEventId: "a-2"});
  });

  it("allows a rider already inside 100 metres to prove Arrived directly", () => {
    const one = advance(null, "direct-1", fix(2_100_000), "Out for delivery", 75);
    const two = advance(one, "direct-2", fix(2_102_500, 13.90001), "Out for delivery", 70);
    expect(one.pendingTransition).toBeUndefined();
    expect(two.pendingTransition).toMatchObject({status: "Arrived", evidenceEventId: "direct-2"});
  });

  it("ignores an impossible location jump without advancing geofence evidence", () => {
    const prior = advance(null, "j-1", fix(3_000_000, 13.9, 79.88), "Out for delivery", 600);
    const jumped = advance(prior, "j-2", fix(3_006_500, 28.61, 77.2), "Out for delivery", 10);
    expect(jumped.lastFixAt).toBe(prior.lastFixAt);
    expect(jumped.consecutiveFixes).toBe(prior.consecutiveFixes);
    expect(jumped.lastRejected).toEqual({eventId: "j-2", reason: "impossible_movement", at: 3_006_600});
    expect(jumped.pendingTransition).toBeUndefined();
  });
});
