import {describe, expect, it} from "vitest";
import {
  buildLifecycleMutation,
  canAdvanceLifecyclePhase,
  deriveLifecycle,
  deriveLifecycleFromCanonicalState,
  LEGACY_STATUS_LIFECYCLE,
  LifecycleTransitionError,
  validateLifecycleTransition,
} from "../src/domain/lifecycle";
import type {LifecycleOrderLike, LifecyclePhases} from "../src/domain/lifecycle";
import type {OrderStatus} from "../src/types";

const currentFlow: OrderStatus[] = [
  "Order placed",
  "Accepted",
  "Preparing",
  "Ready for pickup",
  "Assigned",
  "Handed to rider",
  "Out for delivery",
  "Near you",
  "Arrived",
  "Delivered",
];

function legacy(status: OrderStatus, extra: LifecycleOrderLike = {}) {
  return deriveLifecycle({
    status,
    paymentMethod: "cod",
    paymentState: "cash_due",
    createdAt: 100,
    updatedAt: 200,
    ...extra,
  });
}

describe("versioned additive lifecycle", () => {
  it("preserves every current legacy status and validates the complete live flow", () => {
    expect(Object.keys(LEGACY_STATUS_LIFECYCLE)).toEqual([
      "Order placed",
      "Accepted",
      "Preparing",
      "Ready for pickup",
      "Assigned",
      "Handed to rider",
      "Out for delivery",
      "Near you",
      "Arrived",
      "Delivered",
      "Cancelled",
    ]);

    const snapshots = currentFlow.map((status) => legacy(status));
    for (let index = 1; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1];
      const next = snapshots[index];
      expect(previous).toBeDefined();
      expect(next).toBeDefined();
      expect(validateLifecycleTransition(previous!, next!)).toEqual({
        allowed: true,
        idempotent: false,
        violations: [],
      });
    }

    expect(snapshots.at(-1)).toMatchObject({
      fulfillmentPhase: "delivered",
      dispatchPhase: "completed",
      paymentPhase: "cash_due",
      terminalPhase: "delivered",
    });
  });

  it("recovers the pre-cancellation stage and derives actor-specific outcomes", () => {
    const history = {
      placed: {status: "Order placed", at: 100},
      accepted: {status: "Accepted", at: 200},
      preparing: {status: "Preparing", at: 300},
      cancelled: {status: "Cancelled", at: 400},
    };
    const customerCancellation = legacy("Cancelled", {
      cancelledByRole: "customer",
      statusHistory: history,
    });
    const restaurantRejection = legacy("Cancelled", {
      cancelledByRole: "owner",
      statusBeforeTerminal: "Order placed",
    });

    expect(customerCancellation).toMatchObject({
      fulfillmentPhase: "preparing",
      dispatchPhase: "searching",
      terminalPhase: "customer_cancelled",
    });
    expect(restaurantRejection).toMatchObject({
      fulfillmentPhase: "restaurant_pending",
      terminalPhase: "restaurant_rejected",
    });
    expect(validateLifecycleTransition(legacy("Preparing"), customerCancellation).allowed).toBe(true);
  });

  it("models payment failure and a post-delivery refund without changing legacy status", () => {
    const paymentPending = deriveLifecycle({paymentState: "pending", updatedAt: 100});
    const paymentFailed = deriveLifecycle({paymentState: "failed", updatedAt: 200});
    expect(paymentPending).toMatchObject({
      fulfillmentPhase: "payment_pending",
      paymentPhase: "pending",
      terminalPhase: "none",
    });
    expect(paymentFailed).toMatchObject({
      fulfillmentPhase: "payment_pending",
      paymentPhase: "failed",
      terminalPhase: "payment_failed",
    });
    expect(validateLifecycleTransition(paymentPending, paymentFailed).allowed).toBe(true);

    const deliveredPaid = deriveLifecycle({status: "Delivered", paymentState: "paid", updatedAt: 300});
    const refundPending: LifecyclePhases = {...deliveredPaid, paymentPhase: "refund_pending"};
    const refunded: LifecyclePhases = {
      ...refundPending,
      paymentPhase: "refunded",
      terminalPhase: "refunded",
    };
    expect(validateLifecycleTransition(deliveredPaid, refundPending).allowed).toBe(true);
    expect(validateLifecycleTransition(refundPending, refunded).allowed).toBe(true);
  });

  it("uses current versioned fields deterministically and ignores legacy ambiguity", () => {
    expect(deriveLifecycle({
      status: "Order placed",
      lifecycleVersion: 1,
      lifecycleRevision: 7,
      lifecycleUpdatedAt: 900,
      fulfillmentPhase: "preparing",
      dispatchPhase: "assigned",
      paymentPhase: "authorized",
      terminalPhase: "none",
    })).toEqual({
      lifecycleVersion: 1,
      lifecycleRevision: 7,
      lifecycleUpdatedAt: 900,
      fulfillmentPhase: "preparing",
      dispatchPhase: "assigned",
      paymentPhase: "authorized",
      terminalPhase: "none",
    });
  });

  it("rebuilds a fresh projection from canonical state and preserves an early rider assignment", () => {
    const stale = {
      status: "Preparing",
      riderId: "rider-1",
      paymentMethod: "cod",
      paymentState: "cash_due",
      lifecycleVersion: 1,
      lifecycleRevision: 8,
      lifecycleUpdatedAt: 800,
      fulfillmentPhase: "restaurant_accepted",
      dispatchPhase: "searching",
      paymentPhase: "cash_due",
      terminalPhase: "none",
      updatedAt: 900,
    } as const;
    expect(deriveLifecycle(stale)).toMatchObject({
      fulfillmentPhase: "restaurant_accepted",
      dispatchPhase: "searching",
    });
    expect(deriveLifecycleFromCanonicalState(stale)).toMatchObject({
      fulfillmentPhase: "preparing",
      dispatchPhase: "assigned",
      paymentPhase: "cash_due",
    });
  });

  it("keeps idempotent retries stable and versions a real server mutation once", () => {
    const accepted = {...legacy("Accepted"), lifecycleRevision: 4, lifecycleUpdatedAt: 1_000};
    const retry = buildLifecycleMutation(accepted, accepted, 2_000, {expectedRevision: 4});
    expect(retry).toMatchObject({
      idempotent: true,
      expectedRevision: 4,
      patch: {lifecycleRevision: 4, lifecycleUpdatedAt: 1_000},
    });

    const preparing = legacy("Preparing");
    const mutation = buildLifecycleMutation(accepted, preparing, 2_000, {expectedRevision: 4});
    expect(mutation).toMatchObject({
      idempotent: false,
      expectedRevision: 4,
      patch: {
        lifecycleVersion: 1,
        lifecycleRevision: 5,
        lifecycleUpdatedAt: 2_000,
        fulfillmentPhase: "preparing",
      },
    });
    expect(() => buildLifecycleMutation(accepted, preparing, 2_000, {expectedRevision: 3}))
      .toThrow("LIFECYCLE_REVISION_CONFLICT");
  });

  it("rejects backward movement on every axis and locks operational phases after terminal state", () => {
    expect(canAdvanceLifecyclePhase("fulfillment", "preparing", "restaurant_accepted")).toBe(false);
    expect(canAdvanceLifecyclePhase("dispatch", "assigned", "searching")).toBe(false);
    expect(canAdvanceLifecyclePhase("payment", "paid", "pending")).toBe(false);
    expect(canAdvanceLifecyclePhase("terminal", "delivered", "none")).toBe(false);

    const preparing = legacy("Preparing");
    const accepted = legacy("Accepted");
    const rejected = validateLifecycleTransition(preparing, accepted);
    expect(rejected.allowed).toBe(false);
    expect(rejected.violations.some((violation) =>
      violation.axis === "fulfillment" && violation.code === "BACKWARD_OR_INVALID_TRANSITION")).toBe(true);
    expect(() => buildLifecycleMutation(preparing, accepted, 300))
      .toThrow(LifecycleTransitionError);

    const delivered = deriveLifecycle({status: "Delivered", paymentState: "paid", updatedAt: 500});
    const illegalAfterDelivery: LifecyclePhases = {...delivered, dispatchPhase: "delivering"};
    const terminalResult = validateLifecycleTransition(delivered, illegalAfterDelivery);
    expect(terminalResult.allowed).toBe(false);
    expect(terminalResult.violations.some((violation) =>
      violation.code === "TERMINAL_STATE_LOCKED")).toBe(true);
  });
});
