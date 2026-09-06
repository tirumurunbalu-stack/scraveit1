import {createHash} from "node:crypto";

/**
 * Pure payment-domain model. Persistence and provider SDKs deliberately live
 * outside this module so every mutation can be performed inside one database
 * transaction by the eventual service adapter.
 */
export const PAYMENT_STATES = [
  "not_started",
  "cash_due",
  "initiated",
  "pending",
  "authorized",
  "paid",
  "failed",
  "timed_out",
  "refund_requested",
  "refund_processing",
  "refund_failed",
  "refunded",
] as const;

export const PAYMENT_ACTOR_ROLES = ["customer", "gateway", "system", "admin"] as const;
export const PAYMENT_METHODS = ["cod", "upi", "card"] as const;

export type CanonicalPaymentState = typeof PAYMENT_STATES[number];
export type PaymentActorRole = typeof PAYMENT_ACTOR_ROLES[number];
export type PaymentMethod = typeof PAYMENT_METHODS[number];
export type LegacyPaymentState = "cash_due" | "pending" | "authorized" | "paid" | "refunded" | "failed";
export type LifecyclePaymentPhase =
  | "not_started"
  | "pending"
  | "authorized"
  | "cash_due"
  | "paid"
  | "failed"
  | "refund_pending"
  | "refunded";

export interface PaymentActor {
  readonly role: PaymentActorRole;
  readonly id: string;
}

export interface PaymentAggregate {
  readonly schemaVersion: 1;
  readonly paymentId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly method: PaymentMethod;
  readonly provider?: string;
  readonly currency: "INR";
  readonly amountPaise: number;
  readonly state: CanonicalPaymentState;
  readonly attemptSequence: number;
  readonly currentAttemptId?: string;
  readonly paidAmountPaise: number;
  readonly refundedAmountPaise: number;
  readonly refundRequestId?: string;
  readonly refundAmountPaise?: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreatePaymentInput {
  readonly paymentId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly method: PaymentMethod;
  readonly provider?: string;
  readonly amountPaise: number;
  readonly createdAt: number;
}

export interface HydrateLegacyPaymentInput extends CreatePaymentInput {
  readonly legacyState: LegacyPaymentState;
  readonly revision?: number;
  readonly attemptSequence?: number;
  readonly currentAttemptId?: string;
  readonly updatedAt?: number;
}

export interface PaymentCommand {
  /** Unique API request, gateway-event, or administrative operation key. */
  readonly operationId: string;
  readonly toState: CanonicalPaymentState;
  readonly actor: PaymentActor;
  /** Server receive/commit time injected by the service layer. */
  readonly occurredAt: number;
  readonly attemptId?: string;
  readonly refundRequestId?: string;
  readonly refundAmountPaise?: number;
  readonly reasonCode?: string;
  readonly providerReference?: string;
}

export interface PaymentTransitionEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly previousState: CanonicalPaymentState;
  readonly newState: CanonicalPaymentState;
  readonly actor: PaymentActor;
  readonly occurredAt: number;
  readonly revision: number;
  readonly attemptId?: string;
  readonly refundRequestId?: string;
  readonly reasonCode?: string;
  readonly providerReference?: string;
}

export type PaymentOperationOutcome = "applied" | "idempotent_state" | "ignored_stale";

/**
 * Store this under a payment-scoped operation-id key in the same transaction
 * as the aggregate and transition event. It is the durable idempotency proof.
 */
export interface PaymentOperationRecord {
  readonly schemaVersion: 1;
  readonly paymentId: string;
  readonly operationId: string;
  readonly commandFingerprint: string;
  readonly outcome: PaymentOperationOutcome;
  readonly beforeState: CanonicalPaymentState;
  readonly afterState: CanonicalPaymentState;
  readonly resultingRevision: number;
  readonly processedAt: number;
  readonly reasonCode?: string;
}

export interface PaymentMutationResult {
  readonly kind: "applied" | "idempotent" | "ignored_stale";
  readonly payment: PaymentAggregate;
  readonly operation: PaymentOperationRecord;
  readonly transition?: PaymentTransitionEvent;
}

export interface VerifiedGatewayPaymentEvent {
  readonly verified: boolean;
  readonly provider: string;
  readonly providerEventId: string;
  readonly providerTransactionId: string;
  readonly orderId: string;
  readonly attemptId: string;
  readonly amountPaise: number;
  readonly currency: "INR";
  readonly outcome: "pending" | "authorized" | "paid" | "failed" | "timed_out";
}

export interface VerifiedGatewayRefundEvent {
  readonly verified: boolean;
  readonly provider: string;
  readonly providerEventId: string;
  readonly providerRefundId: string;
  readonly orderId: string;
  readonly refundRequestId: string;
  readonly amountPaise: number;
  readonly currency: "INR";
  readonly outcome: "processing" | "refunded" | "failed";
}

type TransitionRule = Readonly<{
  to: CanonicalPaymentState;
  actors: readonly PaymentActorRole[];
}>;

const TRANSITIONS: Readonly<Record<CanonicalPaymentState, readonly TransitionRule[]>> = {
  not_started: [
    {to: "initiated", actors: ["customer", "system"]},
    {to: "cash_due", actors: ["system"]},
  ],
  cash_due: [
    {to: "paid", actors: ["system", "admin"]},
  ],
  initiated: [
    {to: "pending", actors: ["gateway", "system"]},
    {to: "authorized", actors: ["gateway"]},
    {to: "paid", actors: ["gateway"]},
    {to: "failed", actors: ["gateway"]},
    {to: "timed_out", actors: ["gateway", "system"]},
  ],
  pending: [
    {to: "authorized", actors: ["gateway"]},
    {to: "paid", actors: ["gateway"]},
    {to: "failed", actors: ["gateway"]},
    {to: "timed_out", actors: ["gateway", "system"]},
  ],
  authorized: [
    {to: "paid", actors: ["gateway"]},
    {to: "failed", actors: ["gateway"]},
    {to: "timed_out", actors: ["gateway", "system"]},
  ],
  paid: [
    {to: "refund_requested", actors: ["customer", "system", "admin"]},
  ],
  failed: [
    {to: "initiated", actors: ["customer", "system"]},
  ],
  timed_out: [
    {to: "initiated", actors: ["customer", "system"]},
  ],
  refund_requested: [
    {to: "refund_processing", actors: ["gateway", "system", "admin"]},
  ],
  refund_processing: [
    {to: "refunded", actors: ["gateway", "system"]},
    {to: "refund_failed", actors: ["gateway", "system"]},
  ],
  refund_failed: [
    {to: "refund_processing", actors: ["system", "admin"]},
  ],
  refunded: [],
};

const stateSet = new Set<string>(PAYMENT_STATES);
const roleSet = new Set<string>(PAYMENT_ACTOR_ROLES);
const methodSet = new Set<string>(PAYMENT_METHODS);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export class PaymentStateError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PaymentStateError";
  }
}

function fail(code: string): never {
  throw new PaymentStateError(code);
}

function identifier(value: string, code: string): string {
  const normalized = String(value ?? "").trim();
  if (!identifierPattern.test(normalized)) fail(code);
  return normalized;
}

function optionalIdentifier(value: string | undefined, code: string): string | undefined {
  return value === undefined ? undefined : identifier(value, code);
}

function timestamp(value: number, code = "PAYMENT_INVALID_TIMESTAMP"): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function paise(value: number, code = "PAYMENT_INVALID_AMOUNT_PAISE"): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function nonNegativePaise(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("PAYMENT_INVALID_REVISION");
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function commandFingerprint(command: PaymentCommand): string {
  return createHash("sha256").update(canonicalize({
    operationId: command.operationId,
    toState: command.toState,
    actor: command.actor,
    attemptId: command.attemptId ?? null,
    refundRequestId: command.refundRequestId ?? null,
    refundAmountPaise: command.refundAmountPaise ?? null,
    reasonCode: command.reasonCode ?? null,
    providerReference: command.providerReference ?? null,
  })).digest("hex");
}

function validateAggregate(payment: PaymentAggregate): void {
  if (payment.schemaVersion !== 1) fail("PAYMENT_UNSUPPORTED_SCHEMA");
  identifier(payment.paymentId, "PAYMENT_INVALID_ID");
  identifier(payment.orderId, "PAYMENT_INVALID_ORDER_ID");
  identifier(payment.customerId, "PAYMENT_INVALID_CUSTOMER_ID");
  if (!methodSet.has(payment.method)) fail("PAYMENT_INVALID_METHOD");
  if (!stateSet.has(payment.state)) fail("PAYMENT_INVALID_STATE");
  if (payment.currency !== "INR") fail("PAYMENT_UNSUPPORTED_CURRENCY");
  paise(payment.amountPaise);
  nonNegativePaise(payment.paidAmountPaise, "PAYMENT_INVALID_PAID_AMOUNT");
  nonNegativePaise(payment.refundedAmountPaise, "PAYMENT_INVALID_REFUNDED_AMOUNT");
  if (payment.paidAmountPaise > payment.amountPaise) fail("PAYMENT_PAID_AMOUNT_EXCEEDS_TOTAL");
  if (payment.refundedAmountPaise > payment.paidAmountPaise) fail("PAYMENT_REFUND_EXCEEDS_PAID");
  if (!Number.isSafeInteger(payment.attemptSequence) || payment.attemptSequence < 0) {
    fail("PAYMENT_INVALID_ATTEMPT_SEQUENCE");
  }
  revision(payment.revision);
  timestamp(payment.createdAt);
  timestamp(payment.updatedAt);
  if (payment.updatedAt < payment.createdAt) fail("PAYMENT_TIMESTAMP_REGRESSION");
  optionalIdentifier(payment.currentAttemptId, "PAYMENT_INVALID_ATTEMPT_ID");
  optionalIdentifier(payment.refundRequestId, "PAYMENT_INVALID_REFUND_REQUEST_ID");
  optionalIdentifier(payment.provider, "PAYMENT_INVALID_PROVIDER");
  if (payment.method === "cod" && payment.provider !== undefined) fail("PAYMENT_COD_PROVIDER_FORBIDDEN");
  if (payment.method !== "cod" && payment.provider === undefined) fail("PAYMENT_PROVIDER_REQUIRED");
  if (payment.state === "cash_due" && payment.method !== "cod") fail("PAYMENT_CASH_DUE_REQUIRES_COD");
  if (payment.method === "cod" && ["initiated", "pending", "authorized", "failed", "timed_out"].includes(payment.state)) {
    fail("PAYMENT_ONLINE_STATE_REQUIRES_ONLINE_METHOD");
  }
  if (payment.currentAttemptId !== undefined && payment.attemptSequence === 0) fail("PAYMENT_ATTEMPT_SEQUENCE_REQUIRED");
  const refundState = ["refund_requested", "refund_processing", "refund_failed", "refunded"].includes(payment.state);
  if (refundState && (!payment.refundRequestId || payment.refundAmountPaise !== payment.amountPaise)) {
    fail("PAYMENT_REFUND_DETAILS_REQUIRED");
  }
}

function actor(command: PaymentCommand, payment: PaymentAggregate): PaymentActor {
  if (!roleSet.has(command.actor.role)) fail("PAYMENT_INVALID_ACTOR_ROLE");
  const id = identifier(command.actor.id, "PAYMENT_INVALID_ACTOR_ID");
  if (command.actor.role === "customer" && id !== payment.customerId) fail("PAYMENT_CUSTOMER_MISMATCH");
  if (command.actor.role === "gateway" && id !== payment.provider) fail("PAYMENT_GATEWAY_MISMATCH");
  return {role: command.actor.role, id};
}

function operationRecord(input: {
  payment: PaymentAggregate;
  command: PaymentCommand;
  fingerprint: string;
  outcome: PaymentOperationOutcome;
  afterState: CanonicalPaymentState;
  resultingRevision: number;
  reasonCode?: string;
}): PaymentOperationRecord {
  return {
    schemaVersion: 1,
    paymentId: input.payment.paymentId,
    operationId: identifier(input.command.operationId, "PAYMENT_INVALID_OPERATION_ID"),
    commandFingerprint: input.fingerprint,
    outcome: input.outcome,
    beforeState: input.payment.state,
    afterState: input.afterState,
    resultingRevision: input.resultingRevision,
    processedAt: input.command.occurredAt,
    ...(input.reasonCode ? {reasonCode: identifier(input.reasonCode, "PAYMENT_INVALID_REASON_CODE")} : {}),
  };
}

function replayResult(
  payment: PaymentAggregate,
  command: PaymentCommand,
  priorOperation: PaymentOperationRecord | undefined,
): PaymentMutationResult | undefined {
  if (!priorOperation) return undefined;
  const fingerprint = commandFingerprint(command);
  if (
    priorOperation.paymentId !== payment.paymentId ||
    priorOperation.operationId !== command.operationId ||
    priorOperation.commandFingerprint !== fingerprint
  ) {
    fail("PAYMENT_OPERATION_CONFLICT");
  }
  return {kind: "idempotent", payment, operation: priorOperation};
}

function assertCommandShape(payment: PaymentAggregate, command: PaymentCommand): PaymentActor {
  if (!stateSet.has(command.toState)) fail("PAYMENT_INVALID_TARGET_STATE");
  identifier(command.operationId, "PAYMENT_INVALID_OPERATION_ID");
  timestamp(command.occurredAt);
  if (command.occurredAt < payment.updatedAt) fail("PAYMENT_TIMESTAMP_REGRESSION");
  optionalIdentifier(command.attemptId, "PAYMENT_INVALID_ATTEMPT_ID");
  optionalIdentifier(command.refundRequestId, "PAYMENT_INVALID_REFUND_REQUEST_ID");
  optionalIdentifier(command.reasonCode, "PAYMENT_INVALID_REASON_CODE");
  optionalIdentifier(command.providerReference, "PAYMENT_INVALID_PROVIDER_REFERENCE");
  if (command.refundAmountPaise !== undefined) paise(command.refundAmountPaise, "PAYMENT_INVALID_REFUND_AMOUNT");
  return actor(command, payment);
}

function requireAttempt(payment: PaymentAggregate, command: PaymentCommand): void {
  const onlineTarget = ["initiated", "pending", "authorized", "failed", "timed_out"].includes(command.toState);
  if (command.toState === "paid" && payment.method !== "cod") {
    if (!command.attemptId || command.attemptId !== payment.currentAttemptId) fail("PAYMENT_ATTEMPT_MISMATCH");
    return;
  }
  if (!onlineTarget) return;
  if (payment.method === "cod") fail("PAYMENT_ONLINE_STATE_REQUIRES_ONLINE_METHOD");
  if (!command.attemptId) fail("PAYMENT_ATTEMPT_ID_REQUIRED");
  if (command.toState === "initiated") {
    if (command.attemptId === payment.currentAttemptId) fail("PAYMENT_ATTEMPT_ALREADY_USED");
  } else if (command.attemptId !== payment.currentAttemptId) {
    fail("PAYMENT_ATTEMPT_MISMATCH");
  }
}

function requireRefund(payment: PaymentAggregate, command: PaymentCommand): void {
  const refundTarget = ["refund_requested", "refund_processing", "refund_failed", "refunded"].includes(command.toState);
  if (!refundTarget) return;
  if (!command.refundRequestId) fail("PAYMENT_REFUND_REQUEST_ID_REQUIRED");
  if (command.toState === "refund_requested") {
    if (command.refundAmountPaise !== payment.amountPaise) fail("PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED");
    if (payment.refundRequestId && payment.refundRequestId !== command.refundRequestId) {
      fail("PAYMENT_REFUND_REQUEST_CONFLICT");
    }
    return;
  }
  if (command.refundRequestId !== payment.refundRequestId) fail("PAYMENT_REFUND_REQUEST_MISMATCH");
  if (command.refundAmountPaise !== undefined && command.refundAmountPaise !== payment.refundAmountPaise) {
    fail("PAYMENT_REFUND_AMOUNT_MISMATCH");
  }
}

export function createPayment(input: CreatePaymentInput): PaymentAggregate {
  const method = input.method;
  if (!methodSet.has(method)) fail("PAYMENT_INVALID_METHOD");
  const provider = optionalIdentifier(input.provider, "PAYMENT_INVALID_PROVIDER");
  const createdAt = timestamp(input.createdAt);
  const payment: PaymentAggregate = {
    schemaVersion: 1,
    paymentId: identifier(input.paymentId, "PAYMENT_INVALID_ID"),
    orderId: identifier(input.orderId, "PAYMENT_INVALID_ORDER_ID"),
    customerId: identifier(input.customerId, "PAYMENT_INVALID_CUSTOMER_ID"),
    method,
    ...(provider ? {provider} : {}),
    currency: "INR",
    amountPaise: paise(input.amountPaise),
    state: method === "cod" ? "cash_due" : "not_started",
    attemptSequence: 0,
    paidAmountPaise: 0,
    refundedAmountPaise: 0,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
  };
  validateAggregate(payment);
  return Object.freeze(payment);
}

export function hydrateLegacyPayment(input: HydrateLegacyPaymentInput): PaymentAggregate {
  const base = createPayment(input);
  const state = canonicalStateFromLegacy(input.legacyState);
  const updatedAt = input.updatedAt === undefined ? base.createdAt : timestamp(input.updatedAt);
  const attemptSequence = input.attemptSequence ?? (input.currentAttemptId ? 1 : 0);
  const paidAmountPaise = ["paid", "refunded"].includes(state) ? base.amountPaise : 0;
  const refundedAmountPaise = state === "refunded" ? base.amountPaise : 0;
  const refundFields = state === "refunded" ? {
    refundRequestId: `legacy-refund:${base.orderId}`,
    refundAmountPaise: base.amountPaise,
  } : {};
  const payment: PaymentAggregate = {
    ...base,
    state,
    attemptSequence,
    ...(input.currentAttemptId ? {currentAttemptId: input.currentAttemptId} : {}),
    paidAmountPaise,
    refundedAmountPaise,
    ...refundFields,
    revision: input.revision ?? 0,
    updatedAt,
  };
  validateAggregate(payment);
  return Object.freeze(payment);
}

export function applyPaymentCommand(
  payment: PaymentAggregate,
  command: PaymentCommand,
  priorOperation?: PaymentOperationRecord,
): PaymentMutationResult {
  validateAggregate(payment);
  const normalizedActor = assertCommandShape(payment, command);
  const replay = replayResult(payment, command, priorOperation);
  if (replay) return replay;
  const fingerprint = commandFingerprint(command);

  if (payment.state === command.toState) {
    if (command.toState === "initiated" && command.attemptId !== payment.currentAttemptId) {
      fail("PAYMENT_TRANSITION_FORBIDDEN:initiated->initiated");
    }
    if (["pending", "authorized", "failed", "timed_out"].includes(command.toState) &&
      command.attemptId !== payment.currentAttemptId) {
      fail("PAYMENT_ATTEMPT_MISMATCH");
    }
    if (["refund_requested", "refund_processing", "refund_failed", "refunded"].includes(command.toState)) {
      requireRefund(payment, command);
    }
    return {
      kind: "idempotent",
      payment,
      operation: operationRecord({
        payment, command, fingerprint, outcome: "idempotent_state",
        afterState: payment.state, resultingRevision: payment.revision,
      }),
    };
  }

  requireAttempt(payment, command);
  requireRefund(payment, command);
  const rule = TRANSITIONS[payment.state].find((candidate) => candidate.to === command.toState);
  if (!rule) fail(`PAYMENT_TRANSITION_FORBIDDEN:${payment.state}->${command.toState}`);
  if (!rule.actors.includes(normalizedActor.role)) {
    fail(`PAYMENT_ACTOR_FORBIDDEN:${normalizedActor.role}:${payment.state}->${command.toState}`);
  }

  const nextRevision = payment.revision + 1;
  if (!Number.isSafeInteger(nextRevision)) fail("PAYMENT_REVISION_OVERFLOW");
  const startingAttempt = command.toState === "initiated";
  const requestingRefund = command.toState === "refund_requested";
  const becamePaid = command.toState === "paid";
  const becameRefunded = command.toState === "refunded";
  const next: PaymentAggregate = {
    ...payment,
    state: command.toState,
    attemptSequence: startingAttempt ? payment.attemptSequence + 1 : payment.attemptSequence,
    ...(startingAttempt ? {currentAttemptId: command.attemptId} : {}),
    paidAmountPaise: becamePaid ? payment.amountPaise : payment.paidAmountPaise,
    refundedAmountPaise: becameRefunded ? payment.amountPaise : payment.refundedAmountPaise,
    ...(requestingRefund ? {
      refundRequestId: command.refundRequestId,
      refundAmountPaise: command.refundAmountPaise,
    } : {}),
    revision: nextRevision,
    updatedAt: command.occurredAt,
  };
  validateAggregate(next);
  const transition: PaymentTransitionEvent = {
    schemaVersion: 1,
    eventId: command.operationId,
    paymentId: payment.paymentId,
    orderId: payment.orderId,
    previousState: payment.state,
    newState: next.state,
    actor: normalizedActor,
    occurredAt: command.occurredAt,
    revision: nextRevision,
    ...(command.attemptId ? {attemptId: command.attemptId} : {}),
    ...(command.refundRequestId ? {refundRequestId: command.refundRequestId} : {}),
    ...(command.reasonCode ? {reasonCode: command.reasonCode} : {}),
    ...(command.providerReference ? {providerReference: command.providerReference} : {}),
  };
  return {
    kind: "applied",
    payment: Object.freeze(next),
    transition: Object.freeze(transition),
    operation: Object.freeze(operationRecord({
      payment, command, fingerprint, outcome: "applied",
      afterState: next.state, resultingRevision: nextRevision,
    })),
  };
}

/** Server/UI adapters can use this to expose actions without duplicating the matrix. */
export function allowedPaymentTargets(
  state: CanonicalPaymentState,
  actorRole: PaymentActorRole,
): readonly CanonicalPaymentState[] {
  if (!stateSet.has(state)) fail("PAYMENT_INVALID_STATE");
  if (!roleSet.has(actorRole)) fail("PAYMENT_INVALID_ACTOR_ROLE");
  return Object.freeze(TRANSITIONS[state]
    .filter((rule) => rule.actors.includes(actorRole))
    .map((rule) => rule.to));
}

export function beginOnlinePaymentAttempt(input: {
  readonly payment: PaymentAggregate;
  readonly operationId: string;
  readonly attemptId: string;
  readonly actor: PaymentActor;
  readonly occurredAt: number;
  readonly priorOperation?: PaymentOperationRecord;
}): PaymentMutationResult {
  return applyPaymentCommand(input.payment, {
    operationId: input.operationId,
    toState: "initiated",
    actor: input.actor,
    occurredAt: input.occurredAt,
    attemptId: input.attemptId,
  }, input.priorOperation);
}

function ignoredGatewayEvent(input: {
  payment: PaymentAggregate;
  command: PaymentCommand;
  priorOperation?: PaymentOperationRecord;
  reasonCode: string;
}): PaymentMutationResult {
  const replay = replayResult(input.payment, input.command, input.priorOperation);
  if (replay) return replay;
  const fingerprint = commandFingerprint(input.command);
  return {
    kind: "ignored_stale",
    payment: input.payment,
    operation: Object.freeze(operationRecord({
      payment: input.payment,
      command: input.command,
      fingerprint,
      outcome: "ignored_stale",
      afterState: input.payment.state,
      resultingRevision: input.payment.revision,
      reasonCode: input.reasonCode,
    })),
  };
}

function validateGatewayEnvelope(
  payment: PaymentAggregate,
  event: Pick<VerifiedGatewayPaymentEvent, "verified" | "provider" | "orderId" | "amountPaise" | "currency">,
): void {
  validateAggregate(payment);
  if (event.verified !== true) fail("PAYMENT_GATEWAY_EVENT_UNVERIFIED");
  if (identifier(event.provider, "PAYMENT_INVALID_PROVIDER") !== payment.provider) fail("PAYMENT_GATEWAY_MISMATCH");
  if (identifier(event.orderId, "PAYMENT_INVALID_ORDER_ID") !== payment.orderId) fail("PAYMENT_ORDER_MISMATCH");
  if (paise(event.amountPaise) !== payment.amountPaise) fail("PAYMENT_AMOUNT_MISMATCH");
  if (event.currency !== payment.currency) fail("PAYMENT_CURRENCY_MISMATCH");
}

export function applyVerifiedGatewayPaymentEvent(input: {
  readonly payment: PaymentAggregate;
  readonly event: VerifiedGatewayPaymentEvent;
  readonly receivedAt: number;
  readonly priorOperation?: PaymentOperationRecord;
}): PaymentMutationResult {
  validateGatewayEnvelope(input.payment, input.event);
  const event = input.event;
  const command: PaymentCommand = {
    operationId: `gateway:${identifier(event.provider, "PAYMENT_INVALID_PROVIDER")}:${identifier(event.providerEventId, "PAYMENT_INVALID_EVENT_ID")}`,
    toState: event.outcome,
    actor: {role: "gateway", id: event.provider},
    occurredAt: timestamp(input.receivedAt),
    attemptId: identifier(event.attemptId, "PAYMENT_INVALID_ATTEMPT_ID"),
    providerReference: identifier(event.providerTransactionId, "PAYMENT_INVALID_PROVIDER_REFERENCE"),
  };
  const replay = replayResult(input.payment, command, input.priorOperation);
  if (replay) return replay;
  if (event.attemptId !== input.payment.currentAttemptId) {
    return ignoredGatewayEvent({...input, command, reasonCode: "STALE_PAYMENT_ATTEMPT"});
  }
  if (["refund_requested", "refund_processing", "refund_failed", "refunded"].includes(input.payment.state) ||
    (input.payment.state === "paid" && event.outcome !== "paid")) {
    return ignoredGatewayEvent({...input, command, reasonCode: "STALE_GATEWAY_REGRESSION"});
  }
  return applyPaymentCommand(input.payment, command);
}

export function applyVerifiedGatewayRefundEvent(input: {
  readonly payment: PaymentAggregate;
  readonly event: VerifiedGatewayRefundEvent;
  readonly receivedAt: number;
  readonly priorOperation?: PaymentOperationRecord;
}): PaymentMutationResult {
  validateGatewayEnvelope(input.payment, input.event);
  const event = input.event;
  const toState: CanonicalPaymentState = event.outcome === "processing" ?
    "refund_processing" : event.outcome === "refunded" ? "refunded" : "refund_failed";
  const command: PaymentCommand = {
    operationId: `gateway:${identifier(event.provider, "PAYMENT_INVALID_PROVIDER")}:${identifier(event.providerEventId, "PAYMENT_INVALID_EVENT_ID")}`,
    toState,
    actor: {role: "gateway", id: event.provider},
    occurredAt: timestamp(input.receivedAt),
    refundRequestId: identifier(event.refundRequestId, "PAYMENT_INVALID_REFUND_REQUEST_ID"),
    refundAmountPaise: paise(event.amountPaise, "PAYMENT_INVALID_REFUND_AMOUNT"),
    providerReference: identifier(event.providerRefundId, "PAYMENT_INVALID_PROVIDER_REFERENCE"),
  };
  const replay = replayResult(input.payment, command, input.priorOperation);
  if (replay) return replay;
  if (event.refundRequestId !== input.payment.refundRequestId) {
    return ignoredGatewayEvent({...input, command, reasonCode: "STALE_REFUND_REQUEST"});
  }
  if (input.payment.state === "refunded" && toState !== "refunded") {
    return ignoredGatewayEvent({...input, command, reasonCode: "STALE_REFUND_REGRESSION"});
  }
  return applyPaymentCommand(input.payment, command);
}

export function canonicalStateFromLegacy(state: LegacyPaymentState): CanonicalPaymentState {
  switch (state) {
  case "cash_due": return "cash_due";
  case "pending": return "pending";
  case "authorized": return "authorized";
  case "paid": return "paid";
  case "failed": return "failed";
  case "refunded": return "refunded";
  default: fail("PAYMENT_INVALID_LEGACY_STATE");
  }
}

export function legacyStateForCanonical(state: CanonicalPaymentState): LegacyPaymentState | null {
  switch (state) {
  case "not_started": return null;
  case "cash_due": return "cash_due";
  case "initiated":
  case "pending": return "pending";
  case "authorized": return "authorized";
  case "paid":
  case "refund_requested":
  case "refund_processing":
  case "refund_failed": return "paid";
  case "failed":
  case "timed_out": return "failed";
  case "refunded": return "refunded";
  default: fail("PAYMENT_INVALID_STATE");
  }
}

export function lifecyclePhaseForPayment(state: CanonicalPaymentState): LifecyclePaymentPhase {
  switch (state) {
  case "not_started": return "not_started";
  case "cash_due": return "cash_due";
  case "initiated":
  case "pending": return "pending";
  case "authorized": return "authorized";
  case "paid": return "paid";
  case "failed":
  case "timed_out": return "failed";
  case "refund_requested":
  case "refund_processing":
  case "refund_failed": return "refund_pending";
  case "refunded": return "refunded";
  default: fail("PAYMENT_INVALID_STATE");
  }
}

export function paymentCompatibilityProjection(payment: PaymentAggregate): Readonly<{
  paymentStateVersion: 1;
  paymentState: LegacyPaymentState | null;
  paymentPhase: LifecyclePaymentPhase;
  paymentRevision: number;
  paymentUpdatedAt: number;
}> {
  validateAggregate(payment);
  return Object.freeze({
    paymentStateVersion: 1,
    paymentState: legacyStateForCanonical(payment.state),
    paymentPhase: lifecyclePhaseForPayment(payment.state),
    paymentRevision: payment.revision,
    paymentUpdatedAt: payment.updatedAt,
  });
}
