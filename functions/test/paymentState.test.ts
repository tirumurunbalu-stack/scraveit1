import {describe, expect, it} from "vitest";
import {
  applyPaymentCommand,
  applyVerifiedGatewayPaymentEvent,
  applyVerifiedGatewayRefundEvent,
  allowedPaymentTargets,
  beginOnlinePaymentAttempt,
  canonicalStateFromLegacy,
  createPayment,
  hydrateLegacyPayment,
  legacyStateForCanonical,
  lifecyclePhaseForPayment,
  paymentCompatibilityProjection,
  PaymentStateError,
} from "../src/domain/paymentState";
import type {
  PaymentActor,
  PaymentAggregate,
  PaymentMutationResult,
  VerifiedGatewayPaymentEvent,
  VerifiedGatewayRefundEvent,
} from "../src/domain/paymentState";

const customer: PaymentActor = {role: "customer", id: "customer-1"};
const system: PaymentActor = {role: "system", id: "payment-service"};
const admin: PaymentActor = {role: "admin", id: "admin-1"};

function online(): PaymentAggregate {
  return createPayment({
    paymentId: "payment:order-1",
    orderId: "order-1",
    customerId: "customer-1",
    method: "upi",
    provider: "phonepe",
    amountPaise: 14_000,
    createdAt: 1_000,
  });
}

function begin(payment = online(), at = 2_000, attemptId = "attempt-1"): PaymentMutationResult {
  return beginOnlinePaymentAttempt({
    payment,
    operationId: `begin:${attemptId}`,
    attemptId,
    actor: customer,
    occurredAt: at,
  });
}

function gatewayEvent(
  outcome: VerifiedGatewayPaymentEvent["outcome"],
  providerEventId: string,
  attemptId = "attempt-1",
): VerifiedGatewayPaymentEvent {
  return {
    verified: true,
    provider: "phonepe",
    providerEventId,
    providerTransactionId: "phonepe-transaction-1",
    orderId: "order-1",
    attemptId,
    amountPaise: 14_000,
    currency: "INR",
    outcome,
  };
}

function callback(payment: PaymentAggregate, outcome: VerifiedGatewayPaymentEvent["outcome"], eventId: string, at: number) {
  return applyVerifiedGatewayPaymentEvent({payment, event: gatewayEvent(outcome, eventId), receivedAt: at});
}

function paidPayment(): PaymentAggregate {
  const initiated = begin().payment;
  return callback(initiated, "paid", "event-paid", 3_000).payment;
}

describe("canonical payment state machine", () => {
  it("keeps COD server-authoritative and forbids a customer from marking cash collected", () => {
    const payment = createPayment({
      paymentId: "payment:cod-order",
      orderId: "cod-order",
      customerId: "customer-1",
      method: "cod",
      amountPaise: 12_100,
      createdAt: 1_000,
    });
    expect(payment.state).toBe("cash_due");
    expect(() => applyPaymentCommand(payment, {
      operationId: "fake-cod-payment",
      toState: "paid",
      actor: customer,
      occurredAt: 2_000,
    })).toThrow("PAYMENT_ACTOR_FORBIDDEN:customer:cash_due->paid");

    const completed = applyPaymentCommand(payment, {
      operationId: "delivery:cod-collected",
      toState: "paid",
      actor: system,
      occurredAt: 2_000,
      reasonCode: "DELIVERY_CONFIRMED",
    });
    expect(completed).toMatchObject({
      kind: "applied",
      payment: {state: "paid", paidAmountPaise: 12_100, revision: 1},
      transition: {previousState: "cash_due", newState: "paid", actor: system},
    });
  });

  it("preserves the exact legacy strings while exposing granular internal states", () => {
    expect(canonicalStateFromLegacy("cash_due")).toBe("cash_due");
    expect(canonicalStateFromLegacy("pending")).toBe("pending");
    expect(canonicalStateFromLegacy("authorized")).toBe("authorized");
    expect(canonicalStateFromLegacy("paid")).toBe("paid");
    expect(canonicalStateFromLegacy("failed")).toBe("failed");
    expect(canonicalStateFromLegacy("refunded")).toBe("refunded");
    expect(legacyStateForCanonical("initiated")).toBe("pending");
    expect(legacyStateForCanonical("timed_out")).toBe("failed");
    expect(legacyStateForCanonical("refund_processing")).toBe("paid");
    expect(lifecyclePhaseForPayment("refund_failed")).toBe("refund_pending");

    const legacy = hydrateLegacyPayment({
      paymentId: "payment:legacy-order",
      orderId: "legacy-order",
      customerId: "customer-1",
      method: "upi",
      provider: "phonepe",
      amountPaise: 9_900,
      createdAt: 100,
      legacyState: "authorized",
      currentAttemptId: "legacy-attempt",
      updatedAt: 200,
    });
    expect(paymentCompatibilityProjection(legacy)).toEqual({
      paymentStateVersion: 1,
      paymentState: "authorized",
      paymentPhase: "authorized",
      paymentRevision: 0,
      paymentUpdatedAt: 200,
    });
  });

  it("supports a verified online path without trusting a client success flag", () => {
    const initiated = begin();
    expect(initiated.payment).toMatchObject({state: "initiated", attemptSequence: 1, currentAttemptId: "attempt-1"});
    const pending = callback(initiated.payment, "pending", "event-pending", 3_000);
    const authorized = callback(pending.payment, "authorized", "event-authorized", 4_000);
    const paid = callback(authorized.payment, "paid", "event-paid", 5_000);
    expect(paid.payment).toMatchObject({state: "paid", paidAmountPaise: 14_000, revision: 4});
    expect(paid.transition).toMatchObject({
      previousState: "authorized",
      newState: "paid",
      actor: {role: "gateway", id: "phonepe"},
      providerReference: "phonepe-transaction-1",
    });
  });

  it("makes exact operation retries idempotent and rejects key reuse with different content", () => {
    const first = begin();
    const replay = beginOnlinePaymentAttempt({
      payment: first.payment,
      operationId: "begin:attempt-1",
      attemptId: "attempt-1",
      actor: customer,
      occurredAt: 2_000,
      priorOperation: first.operation,
    });
    expect(replay.kind).toBe("idempotent");
    expect(replay.payment).toBe(first.payment);
    expect(replay.transition).toBeUndefined();

    expect(() => beginOnlinePaymentAttempt({
      payment: first.payment,
      operationId: "begin:attempt-1",
      attemptId: "different-attempt",
      actor: customer,
      occurredAt: 2_000,
      priorOperation: first.operation,
    })).toThrow("PAYMENT_OPERATION_CONFLICT");
  });

  it("deduplicates gateway callbacks and ignores an out-of-order regression after payment", () => {
    const initiated = begin().payment;
    const paid = callback(initiated, "paid", "event-paid", 3_000);
    const replay = applyVerifiedGatewayPaymentEvent({
      payment: paid.payment,
      event: gatewayEvent("paid", "event-paid"),
      receivedAt: 3_000,
      priorOperation: paid.operation,
    });
    expect(replay.kind).toBe("idempotent");

    const duplicateSuccess = callback(paid.payment, "paid", "event-paid-again", 4_000);
    expect(duplicateSuccess).toMatchObject({kind: "idempotent", payment: {state: "paid", revision: 2}});
    expect(duplicateSuccess.operation.outcome).toBe("idempotent_state");

    const delayedFailure = callback(paid.payment, "failed", "event-delayed-failure", 5_000);
    expect(delayedFailure).toMatchObject({
      kind: "ignored_stale",
      payment: {state: "paid", revision: 2},
      operation: {outcome: "ignored_stale", reasonCode: "STALE_GATEWAY_REGRESSION"},
    });
  });

  it("uses a new attempt for retry and ignores callbacks from the superseded attempt", () => {
    const firstAttempt = begin().payment;
    const failed = callback(firstAttempt, "failed", "event-failed", 3_000).payment;
    const retry = begin(failed, 4_000, "attempt-2");
    expect(retry.payment).toMatchObject({state: "initiated", attemptSequence: 2, currentAttemptId: "attempt-2"});

    const stale = applyVerifiedGatewayPaymentEvent({
      payment: retry.payment,
      event: gatewayEvent("paid", "late-first-attempt", "attempt-1"),
      receivedAt: 5_000,
    });
    expect(stale).toMatchObject({
      kind: "ignored_stale",
      payment: {state: "initiated", currentAttemptId: "attempt-2"},
      operation: {reasonCode: "STALE_PAYMENT_ATTEMPT"},
    });
    expect(() => begin(retry.payment, 5_000, "attempt-3"))
      .toThrow("PAYMENT_TRANSITION_FORBIDDEN:initiated->initiated");
  });

  it("supports refund request, processing, failed retry, completion and callback replay", () => {
    const paid = paidPayment();
    const requested = applyPaymentCommand(paid, {
      operationId: "refund-request-1",
      toState: "refund_requested",
      actor: customer,
      occurredAt: 4_000,
      refundRequestId: "refund-1",
      refundAmountPaise: 14_000,
      reasonCode: "CUSTOMER_REQUESTED",
    });
    const processing = applyPaymentCommand(requested.payment, {
      operationId: "refund-submit-1",
      toState: "refund_processing",
      actor: admin,
      occurredAt: 5_000,
      refundRequestId: "refund-1",
    });
    const failedEvent: VerifiedGatewayRefundEvent = {
      verified: true,
      provider: "phonepe",
      providerEventId: "refund-event-failed",
      providerRefundId: "phonepe-refund-1",
      orderId: "order-1",
      refundRequestId: "refund-1",
      amountPaise: 14_000,
      currency: "INR",
      outcome: "failed",
    };
    const failed = applyVerifiedGatewayRefundEvent({payment: processing.payment, event: failedEvent, receivedAt: 6_000});
    expect(failed.payment.state).toBe("refund_failed");
    const retry = applyPaymentCommand(failed.payment, {
      operationId: "refund-retry-1",
      toState: "refund_processing",
      actor: system,
      occurredAt: 7_000,
      refundRequestId: "refund-1",
    });
    const successEvent: VerifiedGatewayRefundEvent = {
      ...failedEvent,
      providerEventId: "refund-event-success",
      outcome: "refunded",
    };
    const success = applyVerifiedGatewayRefundEvent({payment: retry.payment, event: successEvent, receivedAt: 8_000});
    expect(success.payment).toMatchObject({state: "refunded", refundedAmountPaise: 14_000});
    expect(paymentCompatibilityProjection(success.payment)).toMatchObject({
      paymentState: "refunded",
      paymentPhase: "refunded",
    });
    const replay = applyVerifiedGatewayRefundEvent({
      payment: success.payment,
      event: successEvent,
      receivedAt: 8_000,
      priorOperation: success.operation,
    });
    expect(replay.kind).toBe("idempotent");
  });

  it("does not let delayed payment callbacks regress an in-progress refund", () => {
    const paid = paidPayment();
    const requested = applyPaymentCommand(paid, {
      operationId: "refund-request-delayed-callback",
      toState: "refund_requested",
      actor: customer,
      occurredAt: 4_000,
      refundRequestId: "refund-delayed-callback",
      refundAmountPaise: 14_000,
    });
    const delayedPaid = applyVerifiedGatewayPaymentEvent({
      payment: requested.payment,
      event: gatewayEvent("paid", "delayed-success-after-refund"),
      receivedAt: 5_000,
    });
    expect(delayedPaid).toMatchObject({
      kind: "ignored_stale",
      payment: {state: "refund_requested"},
      operation: {reasonCode: "STALE_GATEWAY_REGRESSION"},
    });
  });

  it("supports a trusted, audited cash refund without pretending it came from a gateway", () => {
    const cash = createPayment({
      paymentId: "payment:cash-refund",
      orderId: "cash-refund",
      customerId: "customer-1",
      method: "cod",
      amountPaise: 5_000,
      createdAt: 1_000,
    });
    const paid = applyPaymentCommand(cash, {
      operationId: "cash-collected",
      toState: "paid",
      actor: system,
      occurredAt: 2_000,
    }).payment;
    const requested = applyPaymentCommand(paid, {
      operationId: "cash-refund-requested",
      toState: "refund_requested",
      actor: admin,
      occurredAt: 3_000,
      refundRequestId: "cash-refund-1",
      refundAmountPaise: 5_000,
    }).payment;
    const processing = applyPaymentCommand(requested, {
      operationId: "cash-refund-processing",
      toState: "refund_processing",
      actor: admin,
      occurredAt: 4_000,
      refundRequestId: "cash-refund-1",
    }).payment;
    const refunded = applyPaymentCommand(processing, {
      operationId: "cash-refund-disbursed",
      toState: "refunded",
      actor: system,
      occurredAt: 5_000,
      refundRequestId: "cash-refund-1",
      refundAmountPaise: 5_000,
      reasonCode: "CASH_REFUND_CONFIRMED",
    });
    expect(refunded.payment).toMatchObject({state: "refunded", refundedAmountPaise: 5_000});
    expect(allowedPaymentTargets("refund_processing", "admin")).toEqual([]);
    expect(allowedPaymentTargets("refund_processing", "system")).toEqual(["refunded", "refund_failed"]);
  });

  it("rejects unverified, mismatched, and unauthorized gateway operations", () => {
    const initiated = begin().payment;
    expect(() => applyVerifiedGatewayPaymentEvent({
      payment: initiated,
      event: {...gatewayEvent("paid", "unverified"), verified: false},
      receivedAt: 3_000,
    })).toThrow("PAYMENT_GATEWAY_EVENT_UNVERIFIED");
    expect(() => applyVerifiedGatewayPaymentEvent({
      payment: initiated,
      event: {...gatewayEvent("paid", "wrong-amount"), amountPaise: 1},
      receivedAt: 3_000,
    })).toThrow("PAYMENT_AMOUNT_MISMATCH");
    expect(() => applyPaymentCommand(initiated, {
      operationId: "admin-fake-paid",
      toState: "paid",
      actor: admin,
      occurredAt: 3_000,
      attemptId: "attempt-1",
    })).toThrow("PAYMENT_ACTOR_FORBIDDEN:admin:initiated->paid");
  });

  it("rejects timestamp regressions, partial refunds, and illegal terminal transitions", () => {
    const initiated = begin().payment;
    expect(() => callback(initiated, "pending", "old-event", 1_500)).toThrow("PAYMENT_TIMESTAMP_REGRESSION");
    const paid = callback(initiated, "paid", "event-paid", 3_000).payment;
    expect(() => applyPaymentCommand(paid, {
      operationId: "partial-refund",
      toState: "refund_requested",
      actor: customer,
      occurredAt: 4_000,
      refundRequestId: "refund-partial",
      refundAmountPaise: 7_000,
    })).toThrow("PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED");
    expect(() => applyPaymentCommand(paid, {
      operationId: "restart-paid-payment",
      toState: "initiated",
      actor: system,
      occurredAt: 4_000,
      attemptId: "attempt-2",
    })).toThrow("PAYMENT_TRANSITION_FORBIDDEN:paid->initiated");
    expect(() => applyPaymentCommand(paid, {
      operationId: "admin-direct-refund",
      toState: "refunded",
      actor: admin,
      occurredAt: 4_000,
      refundRequestId: "refund-1",
      refundAmountPaise: 14_000,
    })).toThrow(PaymentStateError);
  });
});
