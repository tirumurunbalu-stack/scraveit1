import {createHash} from "node:crypto";

export const OUTBOX_RECORD_VERSION = 1 as const;
export const OUTBOX_TERMINAL_NEXT_ATTEMPT_AT = Number.MAX_SAFE_INTEGER;

export const OUTBOX_STATUSES = ["pending", "processing", "delivered", "dead_letter"] as const;
export type OutboxStatus = typeof OUTBOX_STATUSES[number];
export type NotificationApp = "customer" | "restaurant" | "rider" | "admin";
export type NotificationRecipientKind = "user" | "restaurant" | "rider" | "admin";

export type RtdbValue = null | boolean | number | string | RtdbValue[] | RtdbObject;
export interface RtdbObject {[key: string]: RtdbValue}

export interface NotificationRecipient {
  kind: NotificationRecipientKind;
  id: string;
  app: NotificationApp;
}

export interface NotificationOutboxInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  deduplicationKey: string;
  recipient: NotificationRecipient;
  message: RtdbObject;
}

export interface OutboxBackoff {
  baseMs: number;
  maxMs: number;
  nextDelayMs: number;
}

export interface OutboxLease {
  owner: string;
  token: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface OutboxFailure {
  code: string;
  message: string;
  retryable: boolean;
  at: number;
}

export interface OutboxDeliveryResult {
  targetCount: number;
  successCount: number;
  permanentFailureCount: number;
  transientFailureCount: number;
  recordedAt: number;
}

/**
 * Opaque device-record identities that have already reached a terminal
 * provider result. Tokens are deliberately never persisted in the outbox.
 */
export interface OutboxTargetProgress {
  successfulTargetIds: string[];
  permanentFailureTargetIds: string[];
}

export interface NotificationOutboxRecord {
  recordVersion: typeof OUTBOX_RECORD_VERSION;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  deduplicationKey: string;
  recipient: NotificationRecipient;
  message: RtdbObject;
  status: OutboxStatus;
  attemptCount: number;
  retryCount: number;
  maxAttempts: number;
  nextAttemptAt: number;
  backoff: OutboxBackoff;
  lease: OutboxLease | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  deadLetteredAt?: number;
  lastAttemptAt?: number;
  lastFailure?: OutboxFailure;
  lastDeliveryResult?: OutboxDeliveryResult;
  targetProgress?: OutboxTargetProgress;
}

export interface CreateOutboxOptions {
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface AcquireOutboxLeaseInput {
  owner: string;
  token: string;
  now: number;
  leaseMs: number;
}

export interface AcquireOutboxLeaseOptions {
  fallback?: NotificationOutboxRecord | null;
}

export interface FailOutboxAttemptInput {
  owner: string;
  token: string;
  now: number;
  code: string;
  message: string;
  retryable?: boolean;
}

export interface ResolveOutboxAttemptOptions {
  fallback?: NotificationOutboxRecord | null;
}

export interface CompleteOutboxAttemptInput {
  owner: string;
  token: string;
  now: number;
  targetCount: number;
  successCount: number;
  permanentFailureCount?: number;
  transientFailureCount?: number;
  successfulTargetIds?: string[];
  permanentFailureTargetIds?: string[];
  transientFailureTargetIds?: string[];
}

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BACKOFF_BASE_MS = 15_000;
const DEFAULT_BACKOFF_MAX_MS = 15 * 60_000;
const INVALID_RTDB_KEY = /[.#$\[\]/]/;
const EVENT_ID_PATTERN = /^notification-[a-f0-9]{48}$/;

function assertInteger(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`INVALID_${name}`);
}

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`INVALID_${name}`);
  return normalized;
}

function cloneRtdbValue(value: RtdbValue, seen = new WeakSet<object>(), depth = 0): RtdbValue {
  if (depth > 24) throw new Error("RTDB_VALUE_TOO_DEEP");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("INVALID_RTDB_NUMBER");
    return value;
  }
  if (seen.has(value)) throw new Error("CIRCULAR_RTDB_VALUE");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: RtdbValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error("SPARSE_RTDB_ARRAY");
        result.push(cloneRtdbValue(value[index]!, seen, depth + 1));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("INVALID_RTDB_OBJECT");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (!key || INVALID_RTDB_KEY.test(key)) throw new Error("INVALID_RTDB_KEY");
      if (entry === undefined) throw new Error("UNDEFINED_RTDB_VALUE");
      return [key, cloneRtdbValue(entry, seen, depth + 1)];
    }));
  } finally {
    seen.delete(value);
  }
}

function normalizeRecipient(recipient: NotificationRecipient): NotificationRecipient {
  const kind = recipient.kind;
  const app = recipient.app;
  if (!["user", "restaurant", "rider", "admin"].includes(kind)) throw new Error("INVALID_RECIPIENT_KIND");
  if (!["customer", "restaurant", "rider", "admin"].includes(app)) throw new Error("INVALID_RECIPIENT_APP");
  return {kind, app, id: boundedText(recipient.id, "RECIPIENT_ID", 256)};
}

function normalizeMessage(message: RtdbObject): RtdbObject {
  const cloned = cloneRtdbValue(message);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    throw new Error("INVALID_OUTBOX_MESSAGE");
  }
  return cloned;
}

function normalizeTimestamp(value: number): number {
  assertInteger(value, "OUTBOX_TIMESTAMP");
  return value;
}

function normalizedIdentity(input: NotificationOutboxInput) {
  return {
    eventType: boundedText(input.eventType, "EVENT_TYPE", 120),
    aggregateType: boundedText(input.aggregateType, "AGGREGATE_TYPE", 80),
    aggregateId: boundedText(input.aggregateId, "AGGREGATE_ID", 256),
    deduplicationKey: boundedText(input.deduplicationKey, "DEDUPLICATION_KEY", 512),
    recipient: normalizeRecipient(input.recipient),
  };
}

/** Stable across retries and processes; message content is deliberately excluded. */
export function deterministicOutboxEventId(input: NotificationOutboxInput): string {
  const identity = normalizedIdentity(input);
  const digest = createHash("sha256").update(JSON.stringify([
    identity.eventType,
    identity.aggregateType,
    identity.aggregateId,
    identity.deduplicationKey,
    identity.recipient.kind,
    identity.recipient.id,
    identity.recipient.app,
  ])).digest("hex").slice(0, 48);
  return `notification-${digest}`;
}

export function isOutboxEventId(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

export function createNotificationOutboxRecord(
  input: NotificationOutboxInput,
  now: number,
  options: CreateOutboxOptions = {},
): NotificationOutboxRecord {
  normalizeTimestamp(now);
  const identity = normalizedIdentity(input);
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  assertInteger(maxAttempts, "MAX_ATTEMPTS", 1);
  assertInteger(baseMs, "BACKOFF_BASE_MS", 1);
  assertInteger(maxMs, "BACKOFF_MAX_MS", baseMs);
  if (maxAttempts > 100) throw new Error("INVALID_MAX_ATTEMPTS");

  return {
    recordVersion: OUTBOX_RECORD_VERSION,
    eventId: deterministicOutboxEventId(input),
    ...identity,
    message: normalizeMessage(input.message),
    status: "pending",
    attemptCount: 0,
    retryCount: 0,
    maxAttempts,
    nextAttemptAt: now,
    backoff: {baseMs, maxMs, nextDelayMs: 0},
    lease: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function computeOutboxBackoffMs(attemptCount: number, backoff: Pick<OutboxBackoff, "baseMs" | "maxMs">): number {
  assertInteger(attemptCount, "ATTEMPT_COUNT", 1);
  assertInteger(backoff.baseMs, "BACKOFF_BASE_MS", 1);
  assertInteger(backoff.maxMs, "BACKOFF_MAX_MS", backoff.baseMs);
  const exponent = Math.min(attemptCount - 1, 30);
  return Math.min(backoff.maxMs, backoff.baseMs * (2 ** exponent));
}

function normalizeFailure(input: FailOutboxAttemptInput): OutboxFailure {
  return {
    code: boundedText(input.code, "FAILURE_CODE", 120),
    message: boundedText(input.message, "FAILURE_MESSAGE", 500),
    retryable: input.retryable !== false,
    at: normalizeTimestamp(input.now),
  };
}

function leaseMatches(record: NotificationOutboxRecord, owner: string, token: string): boolean {
  return record.status === "processing" && record.lease?.owner === owner && record.lease.token === token;
}

function deadLetter(
  current: NotificationOutboxRecord,
  now: number,
  failure: OutboxFailure,
  retryCount = current.retryCount,
): NotificationOutboxRecord {
  return {
    ...current,
    status: "dead_letter",
    retryCount,
    nextAttemptAt: OUTBOX_TERMINAL_NEXT_ATTEMPT_AT,
    lease: null,
    updatedAt: now,
    deadLetteredAt: now,
    lastFailure: failure,
  };
}

/** Pure RTDB transaction updater. Undefined means another worker owns the event. */
export function buildOutboxLeaseCandidate(
  current: NotificationOutboxRecord | null,
  input: AcquireOutboxLeaseInput,
  options: AcquireOutboxLeaseOptions = {},
): NotificationOutboxRecord | undefined {
  const source = current ?? options.fallback ?? null;
  if (!source || source.status === "delivered" || source.status === "dead_letter") return undefined;
  const owner = boundedText(input.owner, "LEASE_OWNER", 200);
  const token = boundedText(input.token, "LEASE_TOKEN", 200);
  const now = normalizeTimestamp(input.now);
  assertInteger(input.leaseMs, "LEASE_MS", 1);
  if (source.status === "processing" && Number(source.lease?.expiresAt ?? 0) > now) return undefined;
  if (source.nextAttemptAt > now) return undefined;
  if (source.attemptCount >= source.maxAttempts) {
    return deadLetter(source, now, {
      code: "MAX_ATTEMPTS_EXHAUSTED",
      message: "The previous delivery lease expired after the final allowed attempt.",
      retryable: false,
      at: now,
    });
  }

  const expiresAt = now + input.leaseMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("INVALID_LEASE_EXPIRY");
  return {
    ...source,
    status: "processing",
    attemptCount: source.attemptCount + 1,
    nextAttemptAt: expiresAt,
    lease: {owner, token, acquiredAt: now, expiresAt},
    updatedAt: now,
    lastAttemptAt: now,
  };
}

/** Pure RTDB transaction updater for a thrown/transient delivery failure. */
export function buildOutboxRetryCandidate(
  current: NotificationOutboxRecord | null,
  input: FailOutboxAttemptInput,
  options: ResolveOutboxAttemptOptions = {},
): NotificationOutboxRecord | undefined {
  const source = current ?? options.fallback ?? null;
  if (!source) return undefined;
  if (source.status === "delivered") return source;
  if (!leaseMatches(source, input.owner, input.token)) return undefined;
  const failure = normalizeFailure(input);
  const retryCount = source.retryCount + 1;
  if (!failure.retryable || source.attemptCount >= source.maxAttempts) {
    return deadLetter(source, input.now, failure, retryCount);
  }
  const delay = computeOutboxBackoffMs(source.attemptCount, source.backoff);
  const nextAttemptAt = input.now + delay;
  if (!Number.isSafeInteger(nextAttemptAt)) throw new Error("INVALID_NEXT_ATTEMPT_AT");
  return {
    ...source,
    status: "pending",
    retryCount,
    nextAttemptAt,
    backoff: {...source.backoff, nextDelayMs: delay},
    lease: null,
    updatedAt: input.now,
    lastFailure: failure,
  };
}

function normalizeDeliveryResult(input: CompleteOutboxAttemptInput): OutboxDeliveryResult {
  const targetCount = input.targetCount;
  const successCount = input.successCount;
  const permanentFailureCount = input.permanentFailureCount ?? 0;
  const suppliedTransient = input.transientFailureCount;
  for (const [name, value] of Object.entries({targetCount, successCount, permanentFailureCount})) {
    assertInteger(value, name.toUpperCase());
  }
  if (successCount + permanentFailureCount > targetCount) throw new Error("INVALID_DELIVERY_COUNTS");
  const transientFailureCount = suppliedTransient ?? targetCount - successCount - permanentFailureCount;
  assertInteger(transientFailureCount, "TRANSIENT_FAILURE_COUNT");
  if (successCount + permanentFailureCount + transientFailureCount !== targetCount) {
    throw new Error("INVALID_DELIVERY_COUNTS");
  }
  return {
    targetCount,
    successCount,
    permanentFailureCount,
    transientFailureCount,
    recordedAt: normalizeTimestamp(input.now),
  };
}

function normalizeTargetIds(values: string[] | undefined, expectedCount: number, name: string): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length !== expectedCount) throw new Error("INVALID_DELIVERY_TARGET_IDS");
  const normalized = values.map((value) => boundedText(value, name, 128));
  if (new Set(normalized).size !== normalized.length) throw new Error("DUPLICATE_DELIVERY_TARGET_IDS");
  return normalized;
}

function deliveryTargetProgress(
  current: NotificationOutboxRecord,
  input: CompleteOutboxAttemptInput,
  result: OutboxDeliveryResult,
): OutboxTargetProgress | undefined {
  const successful = normalizeTargetIds(input.successfulTargetIds, result.successCount, "SUCCESSFUL_TARGET_ID");
  const permanent = normalizeTargetIds(
    input.permanentFailureTargetIds,
    result.permanentFailureCount,
    "PERMANENT_FAILURE_TARGET_ID",
  );
  const transient = normalizeTargetIds(
    input.transientFailureTargetIds,
    result.transientFailureCount,
    "TRANSIENT_FAILURE_TARGET_ID",
  );
  const supplied = successful !== undefined || permanent !== undefined || transient !== undefined;
  if (!supplied) return current.targetProgress;
  if (successful === undefined || permanent === undefined || transient === undefined) {
    throw new Error("INCOMPLETE_DELIVERY_TARGET_IDS");
  }
  const attemptIds = [...successful, ...permanent, ...transient];
  if (new Set(attemptIds).size !== attemptIds.length) throw new Error("OVERLAPPING_DELIVERY_TARGET_IDS");
  return {
    successfulTargetIds: [...new Set([
      ...(current.targetProgress?.successfulTargetIds ?? []),
      ...successful,
    ])].sort(),
    permanentFailureTargetIds: [...new Set([
      ...(current.targetProgress?.permanentFailureTargetIds ?? []),
      ...permanent,
    ])].sort(),
  };
}

/**
 * A logical recipient event completes only after every currently attempted
 * target has reached success or permanent failure. Partial successes are
 * retained as opaque target identities and transient targets are retried,
 * preventing one healthy device from hiding a missed notification on another.
 * Delivered records are returned unchanged for idempotency.
 */
export function buildOutboxDeliveryCandidate(
  current: NotificationOutboxRecord | null,
  input: CompleteOutboxAttemptInput,
  options: ResolveOutboxAttemptOptions = {},
): NotificationOutboxRecord | undefined {
  const source = current ?? options.fallback ?? null;
  if (!source) return undefined;
  if (source.status === "delivered") return source;
  if (!leaseMatches(source, input.owner, input.token)) return undefined;
  const result = normalizeDeliveryResult(input);
  const targetProgress = deliveryTargetProgress(source, input, result);
  const hasRecordedSuccess = (targetProgress?.successfulTargetIds.length ?? 0) > 0;

  if (result.transientFailureCount === 0 && (result.successCount > 0 || hasRecordedSuccess)) {
    return {
      ...source,
      status: "delivered",
      nextAttemptAt: OUTBOX_TERMINAL_NEXT_ATTEMPT_AT,
      backoff: {...source.backoff, nextDelayMs: 0},
      lease: null,
      updatedAt: input.now,
      deliveredAt: input.now,
      lastDeliveryResult: result,
      ...(targetProgress ? {targetProgress} : {}),
    };
  }

  if (result.targetCount > 0 && result.permanentFailureCount === result.targetCount) {
    const failed = deadLetter(source, input.now, {
      code: "ALL_TARGETS_PERMANENTLY_INVALID",
      message: "Every registered target was permanently rejected by the notification provider.",
      retryable: false,
      at: input.now,
    }, source.retryCount + 1);
    return {
      ...failed,
      lastDeliveryResult: result,
      ...(targetProgress ? {targetProgress} : {}),
    };
  }

  const retry = buildOutboxRetryCandidate(source, {
    owner: input.owner,
    token: input.token,
    now: input.now,
    code: result.targetCount === 0 ? "NO_ACTIVE_DEVICE" :
      result.successCount > 0 ? "PARTIAL_FCM_DELIVERY" : "ALL_FCM_DELIVERIES_FAILED",
    message: result.targetCount === 0 ?
      "No active device token was available for this recipient." :
      result.successCount > 0 ?
        "Some target devices accepted the notification while others require retry." :
        "No target device accepted the notification.",
    retryable: true,
  });
  return retry ? {
    ...retry,
    lastDeliveryResult: result,
    ...(targetProgress ? {targetProgress} : {}),
  } : undefined;
}

export function isNotificationOutboxRecord(value: unknown): value is NotificationOutboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<NotificationOutboxRecord>;
  return record.recordVersion === OUTBOX_RECORD_VERSION &&
    isOutboxEventId(record.eventId) &&
    typeof record.eventType === "string" &&
    typeof record.aggregateId === "string" &&
    typeof record.attemptCount === "number" &&
    typeof record.maxAttempts === "number" &&
    typeof record.nextAttemptAt === "number" &&
    OUTBOX_STATUSES.some((status) => status === record.status);
}
