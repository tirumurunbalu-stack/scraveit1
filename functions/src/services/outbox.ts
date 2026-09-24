import {randomUUID} from "node:crypto";
import {firestoreDb} from "../admin";
import {
  buildOutboxDeliveryCandidate,
  buildOutboxLeaseCandidate,
  buildOutboxRetryCandidate,
  createNotificationOutboxRecord,
  isNotificationOutboxRecord,
  isOutboxEventId,
} from "../domain/outbox";
import type {
  CompleteOutboxAttemptInput,
  CreateOutboxOptions,
  FailOutboxAttemptInput,
  NotificationOutboxInput,
  NotificationOutboxRecord,
  OutboxDeliveryResult,
} from "../domain/outbox";
import type {CollectionReferenceLike, DocumentReferenceLike, TransactionLike} from "../firestoreTypes";

function outboxCollectionRef(): CollectionReferenceLike {
  return firestoreDb.collection("private").doc("notificationOutbox").collection("events");
}

function eventRef(eventId: string): DocumentReferenceLike {
  if (!isOutboxEventId(eventId)) throw new Error("INVALID_OUTBOX_EVENT_ID");
  return outboxCollectionRef().doc(eventId);
}

function recordFrom(value: unknown): NotificationOutboxRecord | null {
  return isNotificationOutboxRecord(value) ? value : null;
}

export async function enqueueNotification(
  input: NotificationOutboxInput,
  now = Date.now(),
  options: CreateOutboxOptions = {},
): Promise<NotificationOutboxRecord> {
  const candidate = createNotificationOutboxRecord(input, now, options);
  const ref = eventRef(candidate.eventId);
  const record = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) return recordFrom(snapshot.data());
    transaction.set(ref, candidate);
    return candidate;
  });
  if (!record) throw new Error("OUTBOX_ENQUEUE_ABORTED");
  return record;
}

export interface ClaimedOutboxEvent {
  record: NotificationOutboxRecord;
  leaseToken: string;
}

export async function claimNotification(
  eventId: string,
  workerId: string,
  now = Date.now(),
  leaseMs = 60_000,
  recordHint: NotificationOutboxRecord | null = null,
): Promise<ClaimedOutboxEvent | null> {
  const leaseToken = randomUUID();
  const ref = eventRef(eventId);
  const record = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? recordFrom(snapshot.data()) : null;
    const next = buildOutboxLeaseCandidate(current, {
      owner: workerId,
      token: leaseToken,
      now,
      leaseMs,
    }, {fallback: recordHint});
    if (next === undefined) return null;
    transaction.set(ref, next);
    return next;
  });
  if (record?.status !== "processing" || record.lease?.token !== leaseToken) return null;
  return {record, leaseToken};
}

export async function completeNotification(
  eventId: string,
  input: CompleteOutboxAttemptInput,
  recordHint: NotificationOutboxRecord | null = null,
): Promise<NotificationOutboxRecord | null> {
  const ref = eventRef(eventId);
  return firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? recordFrom(snapshot.data()) : null;
    const next = buildOutboxDeliveryCandidate(current, input, {fallback: recordHint});
    if (next === undefined) return null;
    transaction.set(ref, next);
    return next;
  });
}

export async function failNotification(
  eventId: string,
  input: FailOutboxAttemptInput,
  recordHint: NotificationOutboxRecord | null = null,
): Promise<NotificationOutboxRecord | null> {
  const ref = eventRef(eventId);
  return firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? recordFrom(snapshot.data()) : null;
    const next = buildOutboxRetryCandidate(current, input, {fallback: recordHint});
    if (next === undefined) return null;
    transaction.set(ref, next);
    return next;
  });
}

/** Lists due events; claimNotification() remains the concurrency authority. */
export async function listDueNotifications(
  now = Date.now(),
  limit = 100,
): Promise<NotificationOutboxRecord[]> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_OUTBOX_TIMESTAMP");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_OUTBOX_LIMIT");
  const snapshot = await outboxCollectionRef()
    .where("nextAttemptAt", "<=", now)
    .orderBy("nextAttemptAt", "asc")
    .limit(limit)
    .get();
  return snapshot.docs
    .map((doc) => recordFrom(doc.data()))
    .filter((record): record is NotificationOutboxRecord => record !== null)
    .filter((record) => record.status === "pending" ||
      (record.status === "processing" && Number(record.lease?.expiresAt ?? 0) <= now))
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt ||
      a.eventId.localeCompare(b.eventId));
}

export type ProcessNotificationOutcome =
  | "not_claimed"
  | "delivered"
  | "retry_scheduled"
  | "dead_letter"
  | "lease_lost";

export interface ProcessNotificationResult {
  eventId: string;
  outcome: ProcessNotificationOutcome;
  record: NotificationOutboxRecord | null;
}

export type NotificationDeliveryHandler = (
  record: NotificationOutboxRecord,
) => Promise<NotificationDeliveryAttempt>;

export type NotificationDeliveryAttempt = Omit<OutboxDeliveryResult, "recordedAt"> & Pick<
  CompleteOutboxAttemptInput,
  "successfulTargetIds" | "permanentFailureTargetIds" | "transientFailureTargetIds"
>;

function deliveryFailure(error: unknown): Pick<FailOutboxAttemptInput, "code" | "message" | "retryable"> {
  const candidate = error as {code?: unknown; message?: unknown; retryable?: unknown} | null;
  const code = typeof candidate?.code === "string" && candidate.code.trim() ? candidate.code.slice(0, 120) :
    "NOTIFICATION_DELIVERY_ERROR";
  const message = typeof candidate?.message === "string" && candidate.message.trim() ?
    candidate.message.slice(0, 500) : "The notification delivery handler failed.";
  return {code, message, retryable: candidate?.retryable !== false};
}

/** Claims, delivers, and transactionally completes or reschedules one event. */
export async function processNotification(
  eventId: string,
  workerId: string,
  deliver: NotificationDeliveryHandler,
  recordHint: NotificationOutboxRecord | null = null,
  options: {now?: () => number; leaseMs?: number} = {},
): Promise<ProcessNotificationResult> {
  const clock = options.now ?? Date.now;
  const claimed = await claimNotification(eventId, workerId, clock(), options.leaseMs ?? 60_000, recordHint);
  if (!claimed) return {eventId, outcome: "not_claimed", record: null};
  try {
    const delivery = await deliver(claimed.record);
    const record = await completeNotification(eventId, {
      owner: workerId,
      token: claimed.leaseToken,
      now: clock(),
      ...delivery,
    }, claimed.record);
    if (!record) return {eventId, outcome: "lease_lost", record: null};
    const outcome = record.status === "delivered" ? "delivered" :
      record.status === "dead_letter" ? "dead_letter" : "retry_scheduled";
    return {eventId, outcome, record};
  } catch (error) {
    const failure = deliveryFailure(error);
    const record = await failNotification(eventId, {
      owner: workerId,
      token: claimed.leaseToken,
      now: clock(),
      ...failure,
    }, claimed.record);
    if (!record) return {eventId, outcome: "lease_lost", record: null};
    return {
      eventId,
      outcome: record.status === "dead_letter" ? "dead_letter" : "retry_scheduled",
      record,
    };
  }
}
