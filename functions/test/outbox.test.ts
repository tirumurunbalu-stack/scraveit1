import {describe, expect, it} from "vitest";
import {
  buildOutboxDeliveryCandidate,
  buildOutboxLeaseCandidate,
  buildOutboxRetryCandidate,
  computeOutboxBackoffMs,
  createNotificationOutboxRecord,
  deterministicOutboxEventId,
  OUTBOX_TERMINAL_NEXT_ATTEMPT_AT,
} from "../src/domain/outbox";
import type {NotificationOutboxInput, NotificationOutboxRecord} from "../src/domain/outbox";

const input: NotificationOutboxInput = {
  eventType: "RESTAURANT_NEW_ORDER",
  aggregateType: "order",
  aggregateId: "SV-ORDER-1",
  deduplicationKey: "status-event-placed",
  recipient: {kind: "restaurant", id: "restaurant-1", app: "restaurant"},
  message: {
    notification: {title: "New order", body: "One order needs a decision."},
    data: {type: "NEW_ORDER", orderId: "SV-ORDER-1"},
  },
};

function record(options: {maxAttempts?: number; backoffBaseMs?: number; backoffMaxMs?: number} = {}) {
  return createNotificationOutboxRecord(input, 1_000, options);
}

function claim(current: NotificationOutboxRecord, now = 1_000, token = "lease-token-1") {
  const claimed = buildOutboxLeaseCandidate(current, {
    owner: "worker-1",
    token,
    now,
    leaseMs: 100,
  });
  expect(claimed).toBeDefined();
  return claimed!;
}

describe("durable notification outbox", () => {
  it("uses deterministic recipient-scoped event IDs and creates an RTDB-compatible pending record", () => {
    const created = record();
    expect(created.eventId).toBe(deterministicOutboxEventId(input));
    expect(created.eventId).toMatch(/^notification-[a-f0-9]{48}$/);
    expect(created).toMatchObject({
      recordVersion: 1,
      status: "pending",
      attemptCount: 0,
      retryCount: 0,
      nextAttemptAt: 1_000,
      lease: null,
    });
    expect(deterministicOutboxEventId({...input, message: {changed: true}})).toBe(created.eventId);
    expect(deterministicOutboxEventId({
      ...input,
      recipient: {...input.recipient, id: "restaurant-2"},
    })).not.toBe(created.eventId);
    expect(() => createNotificationOutboxRecord({...input, message: {bad: Number.NaN}}, 1_000))
      .toThrow("INVALID_RTDB_NUMBER");
  });

  it("fences leases and safely reclaims an expired processing attempt", () => {
    const first = claim(record());
    expect(first).toMatchObject({
      status: "processing",
      attemptCount: 1,
      lease: {owner: "worker-1", token: "lease-token-1", expiresAt: 1_100},
    });
    expect(buildOutboxLeaseCandidate(first, {
      owner: "worker-2", token: "lease-token-2", now: 1_099, leaseMs: 100,
    })).toBeUndefined();

    const reclaimed = buildOutboxLeaseCandidate(first, {
      owner: "worker-2", token: "lease-token-2", now: 1_100, leaseMs: 100,
    });
    expect(reclaimed).toMatchObject({
      status: "processing",
      attemptCount: 2,
      lease: {owner: "worker-2", token: "lease-token-2", expiresAt: 1_200},
    });
    expect(buildOutboxDeliveryCandidate(reclaimed!, {
      owner: "worker-1", token: "lease-token-1", now: 1_101, targetCount: 1, successCount: 1,
    })).toBeUndefined();
  });

  it("can build a lease from a known fallback record when the transaction starts from null", () => {
    const created = record();
    const claimed = buildOutboxLeaseCandidate(null, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_000,
      leaseMs: 100,
    }, {fallback: created});
    expect(claimed).toMatchObject({
      status: "processing",
      attemptCount: 1,
      lease: {owner: "worker-1", token: "lease-token-1", expiresAt: 1_100},
    });
  });

  it("keeps a zero-device result retryable instead of falsely marking it delivered", () => {
    const processing = claim(record({backoffBaseMs: 50, backoffMaxMs: 500}));
    const retried = buildOutboxDeliveryCandidate(processing, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      targetCount: 0,
      successCount: 0,
    });
    expect(retried).toMatchObject({
      status: "pending",
      attemptCount: 1,
      retryCount: 1,
      nextAttemptAt: 1_100,
      lease: null,
      lastFailure: {code: "NO_ACTIVE_DEVICE", retryable: true},
      lastDeliveryResult: {targetCount: 0, successCount: 0},
    });
  });

  it("can resolve a retry from a known fallback record when the transaction starts from null", () => {
    const processing = claim(record({backoffBaseMs: 50, backoffMaxMs: 500}));
    const retried = buildOutboxRetryCandidate(null, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      code: "NO_ACTIVE_DEVICE",
      message: "No active device token was available for this recipient.",
      retryable: true,
    }, {fallback: processing});
    expect(retried).toMatchObject({
      status: "pending",
      retryCount: 1,
      lease: null,
      lastFailure: {code: "NO_ACTIVE_DEVICE", retryable: true},
    });
  });

  it("keeps an all-FCM-failure result retryable with exponential backoff metadata", () => {
    const processing = claim(record({backoffBaseMs: 100, backoffMaxMs: 250}));
    const firstRetry = buildOutboxDeliveryCandidate(processing, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      targetCount: 3,
      successCount: 0,
      permanentFailureCount: 1,
      transientFailureCount: 2,
    });
    expect(firstRetry).toMatchObject({
      status: "pending",
      retryCount: 1,
      backoff: {nextDelayMs: 100},
      lastFailure: {code: "ALL_FCM_DELIVERIES_FAILED"},
    });
    expect(computeOutboxBackoffMs(2, {baseMs: 100, maxMs: 250})).toBe(200);
    expect(computeOutboxBackoffMs(3, {baseMs: 100, maxMs: 250})).toBe(250);
    expect(computeOutboxBackoffMs(20, {baseMs: 100, maxMs: 250})).toBe(250);
  });

  it("retries only after a partial multi-device delivery and completes when remaining targets succeed", () => {
    const processing = claim(record());
    const partial = buildOutboxDeliveryCandidate(processing, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      targetCount: 3,
      successCount: 1,
      transientFailureCount: 2,
      successfulTargetIds: ["device-1"],
      permanentFailureTargetIds: [],
      transientFailureTargetIds: ["device-2", "device-3"],
    });
    expect(partial).toMatchObject({
      status: "pending",
      retryCount: 1,
      lastFailure: {code: "PARTIAL_FCM_DELIVERY", retryable: true},
      targetProgress: {successfulTargetIds: ["device-1"], permanentFailureTargetIds: []},
      lastDeliveryResult: {targetCount: 3, successCount: 1, transientFailureCount: 2},
    });

    const secondAttempt = claim(partial!, partial!.nextAttemptAt, "lease-token-2");
    const delivered = buildOutboxDeliveryCandidate(secondAttempt, {
      owner: "worker-1",
      token: "lease-token-2",
      now: partial!.nextAttemptAt + 10,
      targetCount: 2,
      successCount: 2,
      transientFailureCount: 0,
      successfulTargetIds: ["device-2", "device-3"],
      permanentFailureTargetIds: [],
      transientFailureTargetIds: [],
    });
    expect(delivered).toMatchObject({
      status: "delivered",
      nextAttemptAt: OUTBOX_TERMINAL_NEXT_ATTEMPT_AT,
      lease: null,
      targetProgress: {
        successfulTargetIds: ["device-1", "device-2", "device-3"],
        permanentFailureTargetIds: [],
      },
      lastDeliveryResult: {targetCount: 2, successCount: 2, transientFailureCount: 0},
    });
    const duplicate = buildOutboxDeliveryCandidate(delivered!, {
      owner: "stale-worker",
      token: "stale-token",
      now: 9_999,
      targetCount: 0,
      successCount: 0,
    });
    expect(duplicate).toBe(delivered);
  });

  it("completes after a prior success when no unresolved active target remains", () => {
    const processing = claim(record());
    const partial = buildOutboxDeliveryCandidate(processing, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      targetCount: 3,
      successCount: 1,
      permanentFailureCount: 1,
      transientFailureCount: 1,
      successfulTargetIds: ["device-1"],
      permanentFailureTargetIds: ["device-2"],
      transientFailureTargetIds: ["device-3"],
    });
    const retry = claim(partial!, partial!.nextAttemptAt, "lease-token-2");
    const delivered = buildOutboxDeliveryCandidate(retry, {
      owner: "worker-1",
      token: "lease-token-2",
      now: partial!.nextAttemptAt + 1,
      targetCount: 0,
      successCount: 0,
      permanentFailureCount: 0,
      transientFailureCount: 0,
      successfulTargetIds: [],
      permanentFailureTargetIds: [],
      transientFailureTargetIds: [],
    });
    expect(delivered).toMatchObject({
      status: "delivered",
      targetProgress: {
        successfulTargetIds: ["device-1"],
        permanentFailureTargetIds: ["device-2"],
      },
    });
  });

  it("can complete delivery from a known fallback processing record when the transaction starts from null", () => {
    const processing = claim(record());
    const delivered = buildOutboxDeliveryCandidate(null, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      targetCount: 1,
      successCount: 1,
      transientFailureCount: 0,
      successfulTargetIds: ["device-1"],
      permanentFailureTargetIds: [],
      transientFailureTargetIds: [],
    }, {fallback: processing});
    expect(delivered).toMatchObject({
      status: "delivered",
      lease: null,
      targetProgress: {
        successfulTargetIds: ["device-1"],
        permanentFailureTargetIds: [],
      },
    });
  });

  it("rejects incomplete or overlapping target outcome identities", () => {
    const processing = claim(record());
    expect(() => buildOutboxDeliveryCandidate(processing, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      targetCount: 2,
      successCount: 1,
      transientFailureCount: 1,
      successfulTargetIds: ["device-1"],
    })).toThrow("INCOMPLETE_DELIVERY_TARGET_IDS");
    expect(() => buildOutboxDeliveryCandidate(processing, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      targetCount: 2,
      successCount: 1,
      transientFailureCount: 1,
      successfulTargetIds: ["device-1"],
      permanentFailureTargetIds: [],
      transientFailureTargetIds: ["device-1"],
    })).toThrow("OVERLAPPING_DELIVERY_TARGET_IDS");
  });

  it("dead-letters a permanent failure or the final exhausted attempt", () => {
    const permanentlyFailed = buildOutboxRetryCandidate(claim(record()), {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      code: "INVALID_PAYLOAD",
      message: "FCM rejected this message shape.",
      retryable: false,
    });
    expect(permanentlyFailed).toMatchObject({
      status: "dead_letter",
      retryCount: 1,
      deadLetteredAt: 1_050,
      nextAttemptAt: OUTBOX_TERMINAL_NEXT_ATTEMPT_AT,
    });

    const finalAttempt = claim(record({maxAttempts: 1}));
    const exhausted = buildOutboxDeliveryCandidate(finalAttempt, {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      targetCount: 2,
      successCount: 0,
      transientFailureCount: 2,
    });
    expect(exhausted).toMatchObject({
      status: "dead_letter",
      attemptCount: 1,
      retryCount: 1,
      lastFailure: {code: "ALL_FCM_DELIVERIES_FAILED"},
    });

    const allInvalid = buildOutboxDeliveryCandidate(claim(record()), {
      owner: "worker-1",
      token: "lease-token-1",
      now: 1_050,
      targetCount: 2,
      successCount: 0,
      permanentFailureCount: 2,
      transientFailureCount: 0,
    });
    expect(allInvalid).toMatchObject({
      status: "dead_letter",
      lastFailure: {code: "ALL_TARGETS_PERMANENTLY_INVALID", retryable: false},
    });
  });
});
