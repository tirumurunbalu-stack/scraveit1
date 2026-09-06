import {createHash, timingSafeEqual} from "node:crypto";
import {db} from "../admin";
import {pathFor, ROOT} from "../config";
import {
  applyPaymentCommand,
  applyVerifiedGatewayPaymentEvent,
  applyVerifiedGatewayRefundEvent,
  beginOnlinePaymentAttempt,
  createPayment,
  hydrateLegacyPayment,
  paymentCompatibilityProjection,
  type CanonicalPaymentState,
  type PaymentAggregate,
  type PaymentMutationResult,
  type PaymentOperationRecord,
  type PaymentTransitionEvent,
  type VerifiedGatewayPaymentEvent,
  type VerifiedGatewayRefundEvent,
} from "../domain/paymentState";
import {DomainError} from "../errors";
import {
  buildOnlinePaymentReceiptJournal,
  buildOnlinePaymentRefundJournal,
  persistLedgerJournal,
  type LedgerTransactionDatabase,
} from "./ledger";
import type {SavrivoOrder} from "../types";
import type {InitiatePaymentInput} from "./serviceTypes";

export interface PaymentIntent {
  provider: "phonepe";
  merchantOrderId: string;
  redirectUrl: string;
  expiresAt: number;
}

export interface PaymentIntentRequest {
  /** Provider-side idempotency key. A production adapter MUST use this exact ID. */
  merchantOrderId: string;
  idempotencyKey: string;
}

export interface VerifiedPaymentEvent {
  verified: true;
  provider: "phonepe";
  merchantOrderId: string;
  providerTransactionId: string;
  amountPaise: number;
  state: "paid" | "failed" | "refunded";
  /** SHA-256 of the unmodified callback body after signature/status verification. */
  rawEventHash: string;
}

export type VerificationResult =
  | VerifiedPaymentEvent
  | {verified: false; reason: string};

export interface PaymentGateway {
  readonly provider: "phonepe";
  readonly configured: boolean;
  createIntent(order: SavrivoOrder, request: PaymentIntentRequest): Promise<PaymentIntent>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: Buffer): Promise<VerificationResult>;
}

export interface PaymentDataSnapshot {
  val(): unknown;
}

export interface PaymentTransactionResult {
  committed: boolean;
  snapshot: PaymentDataSnapshot;
}

export interface PaymentDataReference {
  get(): Promise<PaymentDataSnapshot>;
  update(values: Record<string, unknown>): Promise<void>;
  transaction(
    update: (current: unknown) => unknown,
    onComplete?: unknown,
    applyLocally?: boolean,
  ): Promise<PaymentTransactionResult>;
}

export interface PaymentDatabase {
  ref(path: string): PaymentDataReference;
}

export interface CanonicalPaymentAttempt {
  schemaVersion: 1;
  attemptId: string;
  provider: "phonepe";
  state: CanonicalPaymentState;
  redirectUrl: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  /** Durable provider identity used to repair journals safely after retries. */
  providerTransactionId?: string;
  /** A full-refund provider identity; conflicting replay IDs are rejected. */
  providerRefundId?: string;
}

export interface CanonicalPaymentRecord {
  schemaVersion: 1;
  aggregate: PaymentAggregate;
  attempts: Record<string, CanonicalPaymentAttempt>;
  operations: Record<string, PaymentOperationRecord>;
  events: Record<string, PaymentTransitionEvent>;
}

export const CANONICAL_PAYMENTS_ROOT = `${ROOT}/private/payments/records`;

/**
 * Fail-closed adapter. Replace only after PhonePe issues production credentials
 * and the exact contracted API/webhook version is confirmed. It deliberately
 * cannot create an intent or return `verified: true`.
 */
export class UnconfiguredPhonePeGateway implements PaymentGateway {
  readonly provider = "phonepe" as const;
  readonly configured = false;

  async createIntent(_order: SavrivoOrder, _request: PaymentIntentRequest): Promise<PaymentIntent> {
    throw new DomainError("failed-precondition", "PhonePe is not configured. COD remains available.");
  }

  async verifyWebhook(_headers: Record<string, string | undefined>, rawBody: Buffer): Promise<VerificationResult> {
    return {
      verified: false,
      reason: rawBody.length ? "PHONEPE_VERIFIER_NOT_CONFIGURED" : "EMPTY_CALLBACK",
    };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string, code: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(normalized)) throw new DomainError("invalid-argument", code);
  return normalized;
}

function positivePaise(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError("failed-precondition", "Order total is not a valid INR amount.");
  }
  return value;
}

function canonicalPaymentId(orderId: string): string {
  return `pay_${hash(`payment:${orderId}`).slice(0, 40)}`;
}

export function canonicalPaymentPath(orderId: string): string {
  return `${CANONICAL_PAYMENTS_ROOT}/${canonicalPaymentId(orderId)}`;
}

function operationKey(operationId: string): string {
  return `op_${hash(operationId).slice(0, 48)}`;
}

function attemptKey(attemptId: string): string {
  return `attempt_${hash(attemptId).slice(0, 48)}`;
}

function eventKey(event: PaymentTransitionEvent): string {
  return `r${String(event.revision).padStart(12, "0")}_${hash(event.eventId).slice(0, 32)}`;
}

function serializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function orderAmountPaise(order: SavrivoOrder): number {
  return positivePaise(Math.round(Number(order.total) * 100));
}

function eligibleOnlinePaymentMethod(value: SavrivoOrder["paymentMethod"]): value is "upi" | "card" {
  return value === "upi" || value === "card";
}

function newPaymentForIntent(order: SavrivoOrder, occurredAt: number): PaymentAggregate {
  const common = {
    paymentId: canonicalPaymentId(order.id),
    orderId: order.id,
    customerId: order.customerId,
    method: order.paymentMethod,
    provider: "phonepe",
    amountPaise: orderAmountPaise(order),
    createdAt: Number.isSafeInteger(order.createdAt) && order.createdAt > 0 ? order.createdAt : occurredAt,
  } as const;
  // Legacy `pending` means the customer selected UPI; it does not prove that a
  // provider attempt exists. Other legacy states are safe to hydrate directly.
  if (order.paymentState === "pending") return createPayment(common);
  return hydrateLegacyPayment({...common, legacyState: order.paymentState, updatedAt: occurredAt});
}

function newPaymentForCallback(order: SavrivoOrder, attemptId: string, occurredAt: number): PaymentAggregate {
  return hydrateLegacyPayment({
    paymentId: canonicalPaymentId(order.id),
    orderId: order.id,
    customerId: order.customerId,
    method: order.paymentMethod,
    provider: "phonepe",
    amountPaise: orderAmountPaise(order),
    createdAt: Number.isSafeInteger(order.createdAt) && order.createdAt > 0 ? order.createdAt : occurredAt,
    legacyState: order.paymentState,
    currentAttemptId: attemptId,
    attemptSequence: 1,
    updatedAt: occurredAt,
  });
}

function createRecord(aggregate: PaymentAggregate): CanonicalPaymentRecord {
  return {schemaVersion: 1, aggregate, attempts: {}, operations: {}, events: {}};
}

function paymentRecord(value: unknown, expectedOrderId?: string): CanonicalPaymentRecord | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("data-loss", "Canonical payment record is malformed.");
  }
  const candidate = value as Partial<CanonicalPaymentRecord>;
  if (candidate.schemaVersion !== 1 || !candidate.aggregate) {
    throw new DomainError("data-loss", "Canonical payment record schema is unsupported.");
  }
  // This invokes the domain's complete aggregate validation without mutation.
  paymentCompatibilityProjection(candidate.aggregate);
  if (expectedOrderId && candidate.aggregate.orderId !== expectedOrderId) {
    throw new DomainError("data-loss", "Canonical payment order mismatch.");
  }
  return {
    schemaVersion: 1,
    aggregate: candidate.aggregate,
    attempts: candidate.attempts && typeof candidate.attempts === "object" ? candidate.attempts : {},
    operations: candidate.operations && typeof candidate.operations === "object" ? candidate.operations : {},
    events: candidate.events && typeof candidate.events === "object" ? candidate.events : {},
  };
}

function priorOperation(record: CanonicalPaymentRecord, operationId: string): PaymentOperationRecord | undefined {
  return record.operations[operationKey(operationId)];
}

function appendMutation(record: CanonicalPaymentRecord, result: PaymentMutationResult): CanonicalPaymentRecord {
  const next: CanonicalPaymentRecord = {
    ...record,
    aggregate: result.payment,
    attempts: {...record.attempts},
    operations: {...record.operations, [operationKey(result.operation.operationId)]: result.operation},
    events: {...record.events},
  };
  if (result.transition) next.events[eventKey(result.transition)] = result.transition;
  return next;
}

function assertPaymentMatchesOrder(record: CanonicalPaymentRecord, order: SavrivoOrder): void {
  const payment = record.aggregate;
  if (
    payment.orderId !== order.id ||
    payment.customerId !== order.customerId ||
    payment.amountPaise !== orderAmountPaise(order) ||
    payment.method !== order.paymentMethod ||
    payment.provider !== "phonepe"
  ) {
    throw new DomainError("data-loss", "Canonical payment does not match the authoritative order.");
  }
}

function deterministicMerchantOrderId(orderId: string, attemptSequence: number): string {
  return `SVPAY_${hash(`${orderId}:${attemptSequence}`).slice(0, 32).toUpperCase()}`;
}

function intentFromAttempt(attempt: CanonicalPaymentAttempt): PaymentIntent {
  return {
    provider: attempt.provider,
    merchantOrderId: attempt.attemptId,
    redirectUrl: attempt.redirectUrl,
    expiresAt: attempt.expiresAt,
  };
}

function currentAttempt(record: CanonicalPaymentRecord): CanonicalPaymentAttempt | undefined {
  const id = record.aggregate.currentAttemptId;
  return id ? record.attempts[attemptKey(id)] : undefined;
}

async function readCanonicalPayment(orderId: string, database: PaymentDatabase): Promise<CanonicalPaymentRecord | null> {
  return paymentRecord((await database.ref(canonicalPaymentPath(orderId)).get()).val(), orderId);
}

async function persistLegacyAttemptProjection(
  order: SavrivoOrder,
  record: CanonicalPaymentRecord,
  attempt: CanonicalPaymentAttempt,
  database: PaymentDatabase,
): Promise<void> {
  const projection = paymentCompatibilityProjection(record.aggregate);
  await database.ref(ROOT).update({
    [`paymentAttempts/${order.id}/${attempt.attemptId}`]: {
      provider: attempt.provider,
      merchantOrderId: attempt.attemptId,
      customerId: order.customerId,
      orderId: order.id,
      amountPaise: record.aggregate.amountPaise,
      state: projection.paymentState ?? "pending",
      redirectUrl: attempt.redirectUrl,
      createdAt: attempt.createdAt,
      expiresAt: attempt.expiresAt,
      updatedAt: attempt.updatedAt,
      canonicalPaymentId: record.aggregate.paymentId,
      paymentRevision: record.aggregate.revision,
    },
    [`paymentAttemptsByMerchantOrder/${attempt.attemptId}`]: {
      customerId: order.customerId,
      orderId: order.id,
      createdAt: attempt.createdAt,
      canonicalPaymentId: record.aggregate.paymentId,
    },
  });
}

export async function initiatePayment(
  uid: string,
  input: InitiatePaymentInput,
  gateway: PaymentGateway,
  database: PaymentDatabase = db as unknown as PaymentDatabase,
  now: () => number = Date.now,
): Promise<PaymentIntent> {
  if (uid !== input.customerId) throw new DomainError("permission-denied", "Payment owner mismatch.");
  const order = (await database.ref(pathFor.order(uid, input.orderId)).get()).val() as SavrivoOrder | null;
  if (!order) throw new DomainError("not-found", "Order not found.");
  if (order.customerId !== uid || order.status !== "Order placed") {
    throw new DomainError("failed-precondition", "Order cannot start an online payment.");
  }
  if (order.paymentState === "paid" || order.paymentState === "refunded") {
    throw new DomainError("already-exists", "Order is already paid.");
  }
  if (!eligibleOnlinePaymentMethod(order.paymentMethod) || !["pending", "failed"].includes(order.paymentState)) {
    throw new DomainError(
      "failed-precondition",
      "This is not an eligible online-payment order. COD cannot be converted after creation.",
    );
  }

  const observedAt = now();
  const observed = await readCanonicalPayment(order.id, database);
  if (observed) assertPaymentMatchesOrder(observed, order);
  const observedAttempt = observed ? currentAttempt(observed) : undefined;
  if (observed && observedAttempt && ["initiated", "pending"].includes(observed.aggregate.state) && observedAttempt.expiresAt > observedAt) {
    await persistLegacyAttemptProjection(order, observed, observedAttempt, database);
    return intentFromAttempt(observedAttempt);
  }
  if (observed && ["authorized", "paid", "refund_requested", "refund_processing", "refund_failed", "refunded"].includes(observed.aggregate.state)) {
    throw new DomainError("failed-precondition", "This payment is already being finalized and cannot start another attempt.");
  }
  if (observed && ["initiated", "pending"].includes(observed.aggregate.state) && !observedAttempt) {
    throw new DomainError("data-loss", "Active payment attempt details are missing; reconciliation is required.");
  }

  const nextSequence = (observed?.aggregate.attemptSequence ?? 0) + 1;
  const requestedMerchantOrderId = deterministicMerchantOrderId(order.id, nextSequence);
  const request: PaymentIntentRequest = {
    merchantOrderId: requestedMerchantOrderId,
    idempotencyKey: `payment:${canonicalPaymentId(order.id)}:attempt:${nextSequence}`,
  };
  // The unconfigured adapter throws here before any state is written. A future
  // production adapter must use request.merchantOrderId as its provider key.
  const providerIntent = await gateway.createIntent(order, request);
  if (
    providerIntent.provider !== gateway.provider ||
    providerIntent.merchantOrderId !== requestedMerchantOrderId ||
    typeof providerIntent.redirectUrl !== "string" ||
    !providerIntent.redirectUrl.trim() ||
    !Number.isSafeInteger(providerIntent.expiresAt) ||
    providerIntent.expiresAt <= observedAt
  ) {
    throw new DomainError("internal", "Payment gateway returned an invalid or non-idempotent intent.");
  }

  const paymentRef = database.ref(canonicalPaymentPath(order.id));
  const tx = await paymentRef.transaction((current) => {
    let record = paymentRecord(current, order.id) ?? createRecord(newPaymentForIntent(order, observedAt));
    assertPaymentMatchesOrder(record, order);
    const active = currentAttempt(record);
    if (active && ["initiated", "pending"].includes(record.aggregate.state) && active.expiresAt > observedAt) {
      return serializable(record);
    }
    if (["authorized", "paid", "refund_requested", "refund_processing", "refund_failed", "refunded"].includes(record.aggregate.state)) {
      throw new DomainError("failed-precondition", "This payment cannot start another attempt.");
    }
    if (["initiated", "pending"].includes(record.aggregate.state)) {
      if (!active || active.expiresAt > observedAt) {
        throw new DomainError("aborted", "Payment state changed concurrently. Retry safely.");
      }
      const timeoutOperationId = `system:timeout:${record.aggregate.currentAttemptId}`;
      record = appendMutation(record, applyPaymentCommand(record.aggregate, {
        operationId: timeoutOperationId,
        toState: "timed_out",
        actor: {role: "system", id: "system:phonepe-intent"},
        occurredAt: observedAt,
        attemptId: record.aggregate.currentAttemptId,
        reasonCode: "PROVIDER_INTENT_EXPIRED",
      }, priorOperation(record, timeoutOperationId)));
    }
    const expectedSequence = record.aggregate.attemptSequence + 1;
    if (expectedSequence !== nextSequence) {
      throw new DomainError("aborted", "Payment attempt changed concurrently. Retry safely.");
    }
    const startOperationId = `system:initiate:${requestedMerchantOrderId}`;
    record = appendMutation(record, beginOnlinePaymentAttempt({
      payment: record.aggregate,
      operationId: startOperationId,
      attemptId: requestedMerchantOrderId,
      actor: {role: "system", id: "system:phonepe-intent"},
      occurredAt: observedAt,
      priorOperation: priorOperation(record, startOperationId),
    }));
    const pendingOperationId = `system:pending:${requestedMerchantOrderId}`;
    record = appendMutation(record, applyPaymentCommand(record.aggregate, {
      operationId: pendingOperationId,
      toState: "pending",
      actor: {role: "system", id: "system:phonepe-intent"},
      occurredAt: observedAt,
      attemptId: requestedMerchantOrderId,
    }, priorOperation(record, pendingOperationId)));
    record.attempts[attemptKey(requestedMerchantOrderId)] = {
      schemaVersion: 1,
      attemptId: requestedMerchantOrderId,
      provider: gateway.provider,
      state: "pending",
      redirectUrl: providerIntent.redirectUrl,
      createdAt: observedAt,
      expiresAt: providerIntent.expiresAt,
      updatedAt: observedAt,
    };
    return serializable(record);
  }, undefined, false);
  if (!tx.committed) throw new DomainError("aborted", "Payment attempt was not committed. Retry safely.");
  const committed = paymentRecord(tx.snapshot.val(), order.id);
  if (!committed) throw new DomainError("data-loss", "Committed payment record is missing.");
  const committedAttempt = currentAttempt(committed);
  if (!committedAttempt) throw new DomainError("data-loss", "Committed payment attempt is missing.");
  await persistLegacyAttemptProjection(order, committed, committedAttempt, database);
  return intentFromAttempt(committedAttempt);
}

function callbackPaymentEvent(event: VerifiedPaymentEvent, orderId: string): VerifiedGatewayPaymentEvent {
  return {
    verified: true,
    provider: event.provider,
    providerEventId: event.rawEventHash,
    providerTransactionId: event.providerTransactionId,
    orderId,
    attemptId: event.merchantOrderId,
    amountPaise: event.amountPaise,
    currency: "INR",
    outcome: event.state === "refunded" ? "paid" : event.state,
  };
}

function appendPaymentCallback(
  record: CanonicalPaymentRecord,
  order: SavrivoOrder,
  event: VerifiedPaymentEvent,
  receivedAt: number,
): CanonicalPaymentRecord {
  if (event.state !== "refunded") {
    const envelope = callbackPaymentEvent(event, order.id);
    const operationId = `gateway:${envelope.provider}:${envelope.providerEventId}`;
    return appendMutation(record, applyVerifiedGatewayPaymentEvent({
      payment: record.aggregate,
      event: envelope,
      receivedAt,
      priorOperation: priorOperation(record, operationId),
    }));
  }

  const refundRequestId = record.aggregate.refundRequestId ?? `refund:${record.aggregate.paymentId}`;
  if (record.aggregate.state === "paid") {
    const requestOperationId = `system:refund-request:${refundRequestId}`;
    record = appendMutation(record, applyPaymentCommand(record.aggregate, {
      operationId: requestOperationId,
      toState: "refund_requested",
      actor: {role: "system", id: "system:phonepe-refund"},
      occurredAt: receivedAt,
      refundRequestId,
      refundAmountPaise: event.amountPaise,
    }, priorOperation(record, requestOperationId)));
  }
  if (["refund_requested", "refund_failed"].includes(record.aggregate.state)) {
    const processingOperationId = `system:refund-processing:${refundRequestId}:${event.rawEventHash}`;
    record = appendMutation(record, applyPaymentCommand(record.aggregate, {
      operationId: processingOperationId,
      toState: "refund_processing",
      actor: {role: "system", id: "system:phonepe-refund"},
      occurredAt: receivedAt,
      refundRequestId,
      refundAmountPaise: event.amountPaise,
    }, priorOperation(record, processingOperationId)));
  }
  if (!["refund_processing", "refunded"].includes(record.aggregate.state)) {
    throw new DomainError("failed-precondition", "Refund callback is invalid for the current payment state.");
  }
  const refundEnvelope: VerifiedGatewayRefundEvent = {
    verified: true,
    provider: event.provider,
    providerEventId: event.rawEventHash,
    providerRefundId: event.providerTransactionId,
    orderId: order.id,
    refundRequestId: record.aggregate.refundRequestId ?? refundRequestId,
    amountPaise: event.amountPaise,
    currency: "INR",
    outcome: "refunded",
  };
  const operationId = `gateway:${refundEnvelope.provider}:${refundEnvelope.providerEventId}`;
  return appendMutation(record, applyVerifiedGatewayRefundEvent({
    payment: record.aggregate,
    event: refundEnvelope,
    receivedAt,
    priorOperation: priorOperation(record, operationId),
  }));
}

function providerReferenceForPaid(record: CanonicalPaymentRecord): string | undefined {
  const transitionReference = firstTransitionTo(record, "paid")?.providerReference;
  if (transitionReference) return transitionReference;
  return currentAttempt(record)?.providerTransactionId;
}

function providerReferenceForRefund(record: CanonicalPaymentRecord): string | undefined {
  const transitionReference = firstTransitionTo(record, "refunded")?.providerReference;
  if (transitionReference) return transitionReference;
  return currentAttempt(record)?.providerRefundId;
}

function firstTransitionTo(record: CanonicalPaymentRecord, state: CanonicalPaymentState): PaymentTransitionEvent | undefined {
  return Object.values(record.events)
    .filter((event) => event.newState === state)
    .sort((left, right) => left.revision - right.revision)[0];
}

async function persistCallbackLedger(
  order: SavrivoOrder,
  record: CanonicalPaymentRecord,
  event: VerifiedPaymentEvent,
  receivedAt: number,
  database: PaymentDatabase,
): Promise<void> {
  const paymentProviderReference = providerReferenceForPaid(record);
  if (["paid", "refund_requested", "refund_processing", "refund_failed", "refunded"].includes(record.aggregate.state)) {
    if (!paymentProviderReference) {
      throw new DomainError("failed-precondition", "Verified gateway receipt must be reconciled before financial posting.");
    }
    const paid = firstTransitionTo(record, "paid");
    await persistLedgerJournal(buildOnlinePaymentReceiptJournal({
      paymentId: record.aggregate.paymentId,
      orderId: order.id,
      paymentProvider: event.provider,
      providerTransactionId: paymentProviderReference,
      amountPaise: record.aggregate.amountPaise,
      occurredAt: paid?.occurredAt ?? receivedAt,
    }), database as unknown as LedgerTransactionDatabase);
  }
  if (record.aggregate.state === "refunded") {
    const refundProviderReference = providerReferenceForRefund(record);
    if (!refundProviderReference) {
      throw new DomainError("failed-precondition", "Verified gateway refund reference is missing.");
    }
    const refunded = firstTransitionTo(record, "refunded");
    await persistLedgerJournal(buildOnlinePaymentRefundJournal({
      paymentId: record.aggregate.paymentId,
      orderId: order.id,
      paymentProvider: event.provider,
      providerTransactionId: refundProviderReference,
      amountPaise: record.aggregate.amountPaise,
      occurredAt: refunded?.occurredAt ?? receivedAt,
      settlementReleased: order.status === "Delivered",
    }), database as unknown as LedgerTransactionDatabase);
  }
}

async function persistLegacyCallbackProjection(
  order: SavrivoOrder,
  record: CanonicalPaymentRecord,
  event: VerifiedPaymentEvent,
  receivedAt: number,
  database: PaymentDatabase,
): Promise<void> {
  const projection = paymentCompatibilityProjection(record.aggregate);
  if (!projection.paymentState) {
    throw new DomainError("data-loss", "Final payment has no legacy compatibility state.");
  }
  const common = {
    paymentState: projection.paymentState,
    paymentPhase: projection.paymentPhase,
    paymentStateVersion: projection.paymentStateVersion,
    paymentRevision: projection.paymentRevision,
    paymentUpdatedAt: projection.paymentUpdatedAt,
    updatedAt: projection.paymentUpdatedAt,
  };
  await database.ref(ROOT).update({
    [`paymentEvents/${event.rawEventHash}`]: {
      ...event,
      receivedAt,
      canonicalPaymentId: record.aggregate.paymentId,
      paymentRevision: record.aggregate.revision,
    },
    [`paymentAttempts/${order.id}/${event.merchantOrderId}/state`]: projection.paymentState,
    [`paymentAttempts/${order.id}/${event.merchantOrderId}/updatedAt`]: projection.paymentUpdatedAt,
    [`paymentAttempts/${order.id}/${event.merchantOrderId}/canonicalPaymentId`]: record.aggregate.paymentId,
    [`orders/${order.customerId}/${order.id}/paymentState`]: common.paymentState,
    [`orders/${order.customerId}/${order.id}/paymentPhase`]: common.paymentPhase,
    [`orders/${order.customerId}/${order.id}/paymentStateVersion`]: common.paymentStateVersion,
    [`orders/${order.customerId}/${order.id}/paymentRevision`]: common.paymentRevision,
    [`orders/${order.customerId}/${order.id}/paymentUpdatedAt`]: common.paymentUpdatedAt,
    [`orders/${order.customerId}/${order.id}/updatedAt`]: common.updatedAt,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/paymentState`]: common.paymentState,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/paymentPhase`]: common.paymentPhase,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/paymentStateVersion`]: common.paymentStateVersion,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/paymentRevision`]: common.paymentRevision,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/paymentUpdatedAt`]: common.paymentUpdatedAt,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/updatedAt`]: common.updatedAt,
  });
}

export async function applyVerifiedPayment(
  event: VerifiedPaymentEvent,
  database: PaymentDatabase = db as unknown as PaymentDatabase,
  now: () => number = Date.now,
): Promise<void> {
  if (event.verified !== true) throw new DomainError("permission-denied", "Unverified payment event rejected.");
  safeSegment(event.merchantOrderId, "Invalid merchant order ID.");
  if (!/^[a-fA-F0-9]{64}$/.test(event.rawEventHash)) {
    throw new DomainError("invalid-argument", "Invalid verified callback hash.");
  }
  positivePaise(event.amountPaise);
  const locator = (await database.ref(`${ROOT}/paymentAttemptsByMerchantOrder/${event.merchantOrderId}`).get())
    .val() as {customerId?: string; orderId?: string} | null;
  if (!locator?.customerId || !locator.orderId) throw new DomainError("not-found", "Payment attempt not found.");
  safeSegment(locator.customerId, "Payment customer locator is invalid.");
  safeSegment(locator.orderId, "Payment order locator is invalid.");
  const order = (await database.ref(pathFor.order(locator.customerId, locator.orderId)).get()).val() as SavrivoOrder | null;
  if (!order) throw new DomainError("not-found", "Payment order not found.");
  if (order.customerId !== locator.customerId || order.id !== locator.orderId ||
    !eligibleOnlinePaymentMethod(order.paymentMethod)) {
    throw new DomainError("failed-precondition", "Payment attempt does not match an eligible online order.");
  }
  if (event.amountPaise !== orderAmountPaise(order)) {
    throw new DomainError("failed-precondition", "Verified payment amount does not match the order.");
  }

  const receivedAt = now();
  const paymentRef = database.ref(canonicalPaymentPath(order.id));
  const tx = await paymentRef.transaction((current) => {
    let record = paymentRecord(current, order.id) ??
      createRecord(newPaymentForCallback(order, event.merchantOrderId, receivedAt));
    assertPaymentMatchesOrder(record, order);
    const existingAttemptId = record.aggregate.currentAttemptId ?? event.merchantOrderId;
    const existingAttempt = record.attempts[attemptKey(existingAttemptId)];
    if (event.state === "paid" && existingAttempt?.providerTransactionId &&
      existingAttempt.providerTransactionId !== event.providerTransactionId) {
      throw new DomainError("already-exists", "Payment attempt already has a different verified provider transaction.");
    }
    if (event.state === "refunded") {
      const verifiedPaymentReference = firstTransitionTo(record, "paid")?.providerReference ??
        existingAttempt?.providerTransactionId;
      if (!verifiedPaymentReference) {
        throw new DomainError(
          "failed-precondition",
          "Legacy paid payment requires verified receipt reconciliation before automated refund.",
        );
      }
      if (existingAttempt?.providerRefundId && existingAttempt.providerRefundId !== event.providerTransactionId) {
        throw new DomainError("already-exists", "Payment already has a different verified provider refund.");
      }
    }
    if (record.aggregate.currentAttemptId && record.aggregate.currentAttemptId !== event.merchantOrderId &&
      !["paid", "refund_requested", "refund_processing", "refund_failed", "refunded"].includes(record.aggregate.state)) {
      throw new DomainError("failed-precondition", "Verified callback belongs to a stale payment attempt.");
    }
    record = appendPaymentCallback(record, order, event, receivedAt);
    const currentAttemptId = record.aggregate.currentAttemptId ?? event.merchantOrderId;
    const key = attemptKey(currentAttemptId);
    const prior = record.attempts[key];
    record.attempts[key] = {
      schemaVersion: 1,
      attemptId: currentAttemptId,
      provider: event.provider,
      state: record.aggregate.state,
      redirectUrl: prior?.redirectUrl ?? "reconciled://legacy-payment-attempt",
      createdAt: prior?.createdAt ?? receivedAt,
      expiresAt: prior?.expiresAt ?? receivedAt,
      updatedAt: record.aggregate.updatedAt,
      ...(event.state === "paid" ? {
        providerTransactionId: prior?.providerTransactionId ?? event.providerTransactionId,
      } : prior?.providerTransactionId ? {providerTransactionId: prior.providerTransactionId} : {}),
      ...(event.state === "refunded" ? {
        providerRefundId: prior?.providerRefundId ?? event.providerTransactionId,
      } : prior?.providerRefundId ? {providerRefundId: prior.providerRefundId} : {}),
    };
    return serializable(record);
  }, undefined, false);
  if (!tx.committed) throw new DomainError("aborted", "Verified payment transition was not committed.");
  const committed = paymentRecord(tx.snapshot.val(), order.id);
  if (!committed) throw new DomainError("data-loss", "Committed payment record is missing.");

  // Canonical state commits first. If an immutable journal or legacy projection
  // temporarily fails, provider retry safely resumes here without a second
  // transition or duplicate ledger entry.
  await persistCallbackLedger(order, committed, event, receivedAt, database);
  await persistLegacyCallbackProjection(order, committed, event, receivedAt, database);
}

export function callbackHash(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
