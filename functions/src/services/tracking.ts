import {firestoreDb} from "../admin";
import {
  advanceTrackingEvidence,
  hasReachedProximityStatus,
  isFreshMonotonicFix,
  normalizeTrackingFix,
  proximityRequirement,
  trackingDistanceMeters,
  type TrackingEvidenceRecord,
} from "../domain/tracking";
import {DomainError} from "../errors";
import type {TransactionLike} from "../firestoreTypes";
import {orderRef, riderRef, trackingEvidenceRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";
import {transitionOrderFromTracking} from "./orders";

export interface TrackingUpdateContext {
  orderId: string;
  eventId: string;
  authType: "app_user" | "admin" | "unauthenticated" | "unknown";
  authId?: string;
  before: unknown;
  after: unknown;
  now?: number;
}

export interface TrackingUpdateResult {
  outcome: "ignored" | "evidence_recorded" | "transitioned";
  reason?: string;
  status?: "Near you" | "Arrived";
}

async function clearPendingTransition(
  orderId: string,
  evidenceEventId: string,
  status: "Near you" | "Arrived",
): Promise<void> {
  const ref = trackingEvidenceRef(firestoreDb, orderId);
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const evidence = snapshot.exists ? snapshot.data() as TrackingEvidenceRecord : null;
    if (!evidence?.pendingTransition || evidence.pendingTransition.evidenceEventId !== evidenceEventId ||
      evidence.pendingTransition.status !== status) return;
    const {pendingTransition: _pending, ...rest} = evidence;
    transaction.set(ref, {
      ...rest,
      candidate: "",
      consecutiveFixes: 0,
      lastQualifiedAt: 0,
      lastTransition: {status, at: Date.now(), evidenceEventId},
      updatedAt: Date.now(),
    });
  });
}

export async function processTrackingUpdate(context: TrackingUpdateContext): Promise<TrackingUpdateResult> {
  const now = context.now ?? Date.now();
  if (context.authType !== "app_user" || !context.authId) {
    return {outcome: "ignored", reason: "non_rider_principal"};
  }
  const fix = normalizeTrackingFix(context.after, context.orderId);
  if (!fix || fix.riderId !== context.authId) return {outcome: "ignored", reason: "invalid_fix"};
  const beforeTimestamp = Number((context.before as Record<string, unknown> | null)?.updatedAt ?? 0);
  if (!isFreshMonotonicFix(fix, Number.isFinite(beforeTimestamp) ? beforeTimestamp : 0, now)) {
    return {outcome: "ignored", reason: "stale_or_replayed_fix"};
  }

  const [orderSnapshot, riderSnapshot] = await Promise.all([
    orderRef(firestoreDb, fix.orderId).get(),
    riderRef(firestoreDb, fix.riderId).get(),
  ]);
  const order = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
  const riderStatus = riderSnapshot.exists ? (riderSnapshot.data() as Record<string, unknown>).status : undefined;
  if (!order || order.id !== fix.orderId || order.customerId !== fix.customerId ||
    order.riderId !== fix.riderId || riderStatus !== "approved" ||
    !["Out for delivery", "Near you"].includes(order.status) ||
    !Number.isFinite(Number(order.address?.lat)) || !Number.isFinite(Number(order.address?.lng))) {
    return {outcome: "ignored", reason: "unassigned_or_inactive_order"};
  }

  const distanceMeters = trackingDistanceMeters(fix, {lat: Number(order.address.lat), lng: Number(order.address.lng)});
  const requirement = proximityRequirement(order.status, distanceMeters);
  const evidenceRef = trackingEvidenceRef(firestoreDb, fix.orderId);
  const evidence = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(evidenceRef);
    const current = snapshot.exists ? snapshot.data() as TrackingEvidenceRecord : null;
    const next = advanceTrackingEvidence(current, {
      eventId: context.eventId,
      fix,
      distanceMeters,
      requirement,
      serverNow: now,
    });
    if (!next || next === current) return current;
    transaction.set(evidenceRef, next);
    return next;
  });
  const pending = evidence?.pendingTransition;
  if (!pending) return {outcome: "evidence_recorded"};

  try {
    await transitionOrderFromTracking(
      fix.customerId,
      fix.orderId,
      fix.riderId,
      pending.status,
      pending.evidenceEventId,
      pending.distanceMeters,
    );
    await clearPendingTransition(fix.orderId, pending.evidenceEventId, pending.status);
    return {outcome: "transitioned", status: pending.status};
  } catch (error) {
    if (!(error instanceof DomainError) || !["aborted", "failed-precondition", "not-found"].includes(error.code)) {
      throw error;
    }
    const latestSnapshot = await orderRef(firestoreDb, fix.orderId).get();
    const latest = latestSnapshot.exists ? latestSnapshot.data() as SavrivoOrder : null;
    if (!latest || latest.riderId !== fix.riderId || latest.status === "Cancelled" ||
      hasReachedProximityStatus(latest.status, pending.status)) {
      await clearPendingTransition(fix.orderId, pending.evidenceEventId, pending.status);
      return {outcome: "ignored", reason: "transition_already_resolved"};
    }
    throw error;
  }
}
