import {db} from "../admin";
import {pathFor, ROOT} from "../config";
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
  const ref = db.ref(`${ROOT}/private/trackingEvidence/${orderId}`);
  const cachedEvidence = (await ref.get()).val() as TrackingEvidenceRecord | null;
  await ref.transaction((current: TrackingEvidenceRecord | null) => {
    const evidence = current ?? cachedEvidence;
    if (!evidence?.pendingTransition || evidence.pendingTransition.evidenceEventId !== evidenceEventId ||
      evidence.pendingTransition.status !== status) return undefined;
    const {pendingTransition: _pending, ...rest} = evidence;
    return {
      ...rest,
      candidate: "",
      consecutiveFixes: 0,
      lastQualifiedAt: 0,
      lastTransition: {status, at: Date.now(), evidenceEventId},
      updatedAt: Date.now(),
    };
  }, undefined, false);
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

  const [orderSnapshot, riderStatusSnapshot] = await Promise.all([
    db.ref(pathFor.order(fix.customerId, fix.orderId)).get(),
    db.ref(`${ROOT}/riders/${fix.riderId}/status`).get(),
  ]);
  const order = orderSnapshot.val() as SavrivoOrder | null;
  if (!order || order.id !== fix.orderId || order.customerId !== fix.customerId ||
    order.riderId !== fix.riderId || riderStatusSnapshot.val() !== "approved" ||
    !["Out for delivery", "Near you"].includes(order.status) ||
    !Number.isFinite(Number(order.address?.lat)) || !Number.isFinite(Number(order.address?.lng))) {
    return {outcome: "ignored", reason: "unassigned_or_inactive_order"};
  }

  const distanceMeters = trackingDistanceMeters(fix, {lat: Number(order.address.lat), lng: Number(order.address.lng)});
  const requirement = proximityRequirement(order.status, distanceMeters);
  const evidenceRef = db.ref(`${ROOT}/private/trackingEvidence/${fix.orderId}`);
  const result = await evidenceRef.transaction((current: TrackingEvidenceRecord | null) => {
    const next = advanceTrackingEvidence(current, {
      eventId: context.eventId,
      fix,
      distanceMeters,
      requirement,
      serverNow: now,
    });
    return !next || next === current ? undefined : next;
  }, undefined, false);
  const evidence = result.snapshot.val() as TrackingEvidenceRecord | null;
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
    const latest = (await db.ref(pathFor.order(fix.customerId, fix.orderId)).get()).val() as SavrivoOrder | null;
    if (!latest || latest.riderId !== fix.riderId || latest.status === "Cancelled" ||
      hasReachedProximityStatus(latest.status, pending.status)) {
      await clearPendingTransition(fix.orderId, pending.evidenceEventId, pending.status);
      return {outcome: "ignored", reason: "transition_already_resolved"};
    }
    throw error;
  }
}
