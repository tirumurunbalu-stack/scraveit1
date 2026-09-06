import {describe, expect, it} from "vitest";
import {
  buildRiderClaimRecoveryQueueCandidate,
  decideExpiredRiderClaimRecovery,
  normalizeRiderClaim,
  riderClaimQueueFingerprint,
} from "../src/domain/riderClaimRecovery";

function queue(state: "reserved" | "order_committed" | "finalized" = "reserved") {
  return {
    orderId: "SV-CLAIM-1",
    customerId: "customer-1",
    status: state === "finalized" ? "assigned" : "offering",
    active: state !== "finalized",
    claim: {
      riderId: "rider-1",
      claimedAt: 1_000,
      operationId: "claim_SV-CLAIM-1_rider-1",
      leaseUntil: state === "finalized" ? 1_000 : 2_000,
      state,
    },
    currentOffer: {riderId: "rider-1", offeredAt: 900, expiresAt: 1_500},
    activeOffers: {"rider-1": {riderId: "rider-1", offeredAt: 900, expiresAt: 1_500}},
    offeredRiderId: "rider-1",
    metrics: {offered: 2, accepted: 0, startedAt: 800},
    createdAt: 800,
    updatedAt: 1_000,
  };
}

function order(riderId?: string, status = "Preparing") {
  return {
    id: "SV-CLAIM-1",
    customerId: "customer-1",
    status,
    ...(riderId ? {riderId} : {}),
    ...(riderId ? {riderAssignedAt: 1_250} : {}),
    createdAt: 700,
    updatedAt: riderId ? 1_250 : 1_100,
  };
}

describe("expired rider claim recovery", () => {
  it("waits while a reserved lease remains active", () => {
    const plan = decideExpiredRiderClaimRecovery(queue("reserved"), order(), 1_999);
    expect(plan).toMatchObject({
      action: "wait_for_lease",
      reason: "lease_active",
      authoritativeRiderId: null,
      restartDispatch: false,
    });
    expect(buildRiderClaimRecoveryQueueCandidate(queue("reserved"), plan, 1_999)).toBeUndefined();
  });

  it("releases an expired reservation for redispatch when the authoritative order is unassigned", () => {
    const original = queue("reserved");
    const plan = decideExpiredRiderClaimRecovery(original, order(), 2_000);
    expect(plan).toMatchObject({
      action: "release_for_redispatch",
      reason: "authoritative_order_unassigned",
      clearOutstandingOffers: true,
      stopOutstandingAlerts: true,
      restartDispatch: true,
    });
    const candidate = buildRiderClaimRecoveryQueueCandidate(original, plan, 2_010);
    expect(candidate).toMatchObject({status: "exhausted", active: false, updatedAt: 2_010});
    expect(candidate).not.toHaveProperty("claim");
    expect(candidate).not.toHaveProperty("currentOffer");
    expect(candidate).not.toHaveProperty("activeOffers");
    expect(candidate).not.toHaveProperty("offeredRiderId");
    // Applying the same plan after the first commit is fenced and idempotent.
    expect(buildRiderClaimRecoveryQueueCandidate(candidate!, plan, 2_020)).toBeUndefined();
  });

  it.each(["reserved", "order_committed"] as const)(
    "finalizes an expired %s claim when the order committed the same rider",
    (state) => {
      const original = queue(state);
      const plan = decideExpiredRiderClaimRecovery(original, order("rider-1"), 2_000);
      expect(plan).toMatchObject({
        action: "finalize_authoritative_assignment",
        reason: "authoritative_order_matches_claim",
        authoritativeRiderId: "rider-1",
        assignmentAt: 1_250,
        rebuildRiderProjection: true,
      });
      const candidate = buildRiderClaimRecoveryQueueCandidate(original, plan, 2_010);
      expect(candidate).toMatchObject({
        status: "assigned",
        active: false,
        claim: {
          riderId: "rider-1",
          claimedAt: 1_250,
          operationId: "claim_SV-CLAIM-1_rider-1",
          leaseUntil: 1_250,
          state: "finalized",
        },
        metrics: {offered: 2, accepted: 1, assignedAt: 1_250},
      });
    },
  );

  it("adopts a different authoritative winner instead of reviving the expired claimant", () => {
    const original = queue("reserved");
    const plan = decideExpiredRiderClaimRecovery(original, order("rider-2"), 2_000);
    expect(plan).toMatchObject({
      action: "finalize_authoritative_assignment",
      reason: "authoritative_order_overrides_claim",
      authoritativeRiderId: "rider-2",
    });
    const candidate = buildRiderClaimRecoveryQueueCandidate(original, plan, 2_010);
    expect(candidate?.claim).toEqual({
      riderId: "rider-2",
      claimedAt: 1_250,
      operationId: "claim_SV-CLAIM-1_rider-2",
      leaseUntil: 1_250,
      state: "finalized",
    });
  });

  it("treats a matching finalized queue as an idempotent no-op", () => {
    const {
      currentOffer: _currentOffer,
      activeOffers: _activeOffers,
      offeredRiderId: _offeredRiderId,
      ...finalized
    } = queue("finalized");
    const plan = decideExpiredRiderClaimRecovery(finalized, order("rider-1"), 5_000);
    expect(plan).toMatchObject({
      action: "none",
      reason: "assignment_already_finalized",
      clearOutstandingOffers: false,
      rebuildRiderProjection: false,
    });
    expect(buildRiderClaimRecoveryQueueCandidate(finalized, plan, 5_000)).toBeUndefined();
  });

  it("repairs an inconsistent finalized queue from the authoritative order assignment", () => {
    const inconsistent = queue("finalized");
    const plan = decideExpiredRiderClaimRecovery(inconsistent, order("rider-1"), 5_000);
    expect(plan.action).toBe("finalize_authoritative_assignment");
    expect(buildRiderClaimRecoveryQueueCandidate(inconsistent, plan, 5_010)).toMatchObject({
      status: "assigned",
      active: false,
      claim: {state: "finalized", riderId: "rider-1"},
    });
  });

  it("cancels an expired orphan claim when the order is missing or no longer dispatchable", () => {
    const missingPlan = decideExpiredRiderClaimRecovery(queue(), null, 2_000);
    expect(missingPlan).toMatchObject({action: "cancel_queue", reason: "authoritative_order_missing"});
    expect(buildRiderClaimRecoveryQueueCandidate(queue(), missingPlan, 2_010)).toMatchObject({
      status: "cancelled",
      active: false,
    });

    const cancelledPlan = decideExpiredRiderClaimRecovery(queue(), order(undefined, "Cancelled"), 2_000);
    expect(cancelledPlan).toMatchObject({
      action: "cancel_queue",
      reason: "authoritative_order_not_dispatchable",
    });
  });

  it("normalizes legacy claims without changing legacy order status strings", () => {
    const legacyQueue = {
      ...queue(),
      claim: {riderId: "rider-1", claimedAt: 1_000},
    };
    const normalized = normalizeRiderClaim(legacyQueue.claim, "SV-CLAIM-1", {legacyLeaseMs: 500});
    expect(normalized).toEqual({
      riderId: "rider-1",
      claimedAt: 1_000,
      operationId: "claim_SV-CLAIM-1_rider-1",
      leaseUntil: 1_500,
      state: "reserved",
      inferredState: true,
      inferredLease: true,
    });
    const sourceOrder = order(undefined, "Ready for pickup");
    const plan = decideExpiredRiderClaimRecovery(legacyQueue, sourceOrder, 1_500, {legacyLeaseMs: 500});
    expect(plan.action).toBe("release_for_redispatch");
    expect(sourceOrder.status).toBe("Ready for pickup");
  });

  it("rejects a stale recovery plan after the claim changes", () => {
    const original = queue();
    const plan = decideExpiredRiderClaimRecovery(original, order(), 2_000);
    const changed = {
      ...original,
      claim: {...original.claim, riderId: "rider-3", operationId: "claim-new"},
    };
    expect(riderClaimQueueFingerprint(changed)).not.toBe(plan.expectedQueueFingerprint);
    expect(buildRiderClaimRecoveryQueueCandidate(changed, plan, 2_010)).toBeUndefined();
  });
});
