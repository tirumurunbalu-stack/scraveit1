import {randomUUID} from "node:crypto";
import {db} from "../admin";
import {pathFor, ROOT} from "../config";
import {
  RESTAURANT_ARRIVAL_ORDER_STATUSES,
  verifyRiderRestaurantArrival,
  type RiderRestaurantArrivalEvidence,
  type RiderRestaurantArrivalEvidenceSource,
} from "../domain/riderRestaurantArrival";
import {DomainError} from "../errors";
import type {SavrivoOrder} from "../types";

export const RIDER_RESTAURANT_ARRIVALS_ROOT = `${ROOT}/riderRestaurantArrivals`;
const ARRIVAL_VERIFICATION_LEASE_MS = 30_000;
const ARRIVAL_VERIFICATION_WAIT_MS = 4_000;
const ARRIVAL_VERIFICATION_POLL_MS = 250;

export interface RiderArrivalRecord extends RiderRestaurantArrivalEvidence {
  version: 1;
  source: RiderRestaurantArrivalEvidenceSource;
  status: "verified";
  orderId: string;
  restaurantId: string;
  riderId: string;
  arrivedAt: number;
  verifiedAt: number;
}

interface PendingRiderArrivalRecord {
  version: 1;
  source: "server_verified_pickup_tracking";
  status: "verifying";
  orderId: string;
  riderId: string;
  operationId: string;
  leaseUntil: number;
  updatedAt: number;
}

type StoredRiderArrivalRecord = RiderArrivalRecord | PendingRiderArrivalRecord;

export interface MarkRiderArrivedRestaurantResult {
  orderId: string;
  riderId: string;
  arrivedAt: number;
  distanceMeters: number;
  accuracyMeters: number;
  idempotent: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isVerifiedRecord(value: unknown): value is RiderArrivalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RiderArrivalRecord>;
  return record.version === 1 &&
    (record.source === "server_verified_pickup_tracking" || record.source === "server_verified_pickup_presence") &&
    record.status === "verified" && Boolean(text(record.orderId)) &&
    Boolean(text(record.restaurantId)) && Boolean(text(record.riderId)) &&
    Number.isSafeInteger(Number(record.arrivedAt)) && Number(record.arrivedAt) > 0 &&
    Number.isSafeInteger(Number(record.verifiedAt)) && Number(record.verifiedAt) > 0 &&
    Number.isSafeInteger(Number(record.trackingUpdatedAt)) && Number(record.trackingUpdatedAt) > 0 &&
    Number.isFinite(Number(record.distanceMeters)) && Number(record.distanceMeters) >= 0 &&
    Number.isFinite(Number(record.accuracyMeters)) && Number(record.accuracyMeters) >= 0;
}

function isPendingRecord(value: unknown): value is PendingRiderArrivalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<PendingRiderArrivalRecord>;
  return record.version === 1 && record.source === "server_verified_pickup_tracking" &&
    record.status === "verifying" && Boolean(text(record.orderId)) && Boolean(text(record.riderId)) &&
    Boolean(text(record.operationId)) && Number.isSafeInteger(Number(record.leaseUntil)) &&
    Number(record.leaseUntil) > 0 && Number.isSafeInteger(Number(record.updatedAt)) &&
    Number(record.updatedAt) > 0;
}

async function waitForPendingArrivalResolution(
  orderId: string,
  riderId: string,
  restaurantId: string,
  timeoutMs = ARRIVAL_VERIFICATION_WAIT_MS,
): Promise<RiderArrivalRecord | null> {
  const deadline = Date.now() + timeoutMs;
  const ref = db.ref(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ARRIVAL_VERIFICATION_POLL_MS));
    const current = (await ref.get()).val() as StoredRiderArrivalRecord | null;
    if (isVerifiedRecord(current)) {
      if (current.riderId !== riderId || current.restaurantId !== restaurantId) {
        throw new DomainError("failed-precondition", "Arrival was verified for another assignment.");
      }
      return current;
    }
    if (!isPendingRecord(current)) return null;
    if (current.riderId !== riderId) {
      throw new DomainError("failed-precondition", "Arrival was verified for another assignment.");
    }
    if (Number(current.leaseUntil) <= Date.now()) return null;
  }
  return null;
}

/**
 * Loads the durable server-owned arrival proof used by the handover state
 * transition. A client/projection boolean is never sufficient authority.
 */
export async function requireVerifiedRiderRestaurantArrival(
  order: SavrivoOrder,
): Promise<RiderArrivalRecord> {
  const stored = (await db.ref(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${order.id}`).get()).val();
  if (!isVerifiedRecord(stored) || stored.orderId !== order.id ||
    stored.restaurantId !== order.restaurantId || !order.riderId || stored.riderId !== order.riderId) {
    throw new DomainError(
      "failed-precondition",
      "Confirm the assigned rider's verified restaurant arrival before handover.",
    );
  }
  return stored;
}

function result(record: RiderArrivalRecord, idempotent: boolean): MarkRiderArrivedRestaurantResult {
  return {
    orderId: record.orderId,
    riderId: record.riderId,
    arrivedAt: record.arrivedAt,
    distanceMeters: record.distanceMeters,
    accuracyMeters: record.accuracyMeters,
    idempotent,
  };
}

function projectionUpdates(
  order: SavrivoOrder,
  record: RiderArrivalRecord,
): Record<string, unknown> {
  const boundedVerification = {
    verified: true,
    verifiedAt: record.verifiedAt,
    distanceMeters: record.distanceMeters,
    accuracyMeters: record.accuracyMeters,
    source: record.source,
  };
  return {
    [`riderRestaurantArrivals/${order.id}`]: record,
    [`riderJobs/${record.riderId}/${order.id}/phase`]: "at_restaurant",
    [`riderJobs/${record.riderId}/${order.id}/arrivedRestaurantAt`]: record.arrivedAt,
    [`riderJobs/${record.riderId}/${order.id}/arrivalVerification`]: boundedVerification,
    [`riderJobs/${record.riderId}/${order.id}/updatedAt`]: record.verifiedAt,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/riderArrivedRestaurantAt`]: record.arrivedAt,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/riderArrivalVerified`]: true,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/riderArrivalVerification`]: boundedVerification,
    [`private/operations/orders/${order.id}/riderArrivedRestaurantAt`]: record.arrivedAt,
    [`private/operations/orders/${order.id}/riderArrivalVerified`]: true,
  };
}

async function releaseLease(orderId: string, riderId: string, operationId: string): Promise<void> {
  await db.ref(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`).transaction(
    (current: StoredRiderArrivalRecord | null) =>
      current?.status === "verifying" && current.riderId === riderId && current.operationId === operationId ?
        null : undefined,
    undefined,
    false,
  );
}

/**
 * Verifies pickup arrival from fresh server-visible tracking. The final
 * evidence record, rider projection and privacy-bounded Restaurant/Admin
 * projections are committed in one RTDB multi-location update. A short
 * per-order lease makes concurrent/retried button presses converge safely.
 */
export async function markRiderArrivedRestaurant(
  riderIdValue: unknown,
  orderIdValue: unknown,
  now = Date.now(),
): Promise<MarkRiderArrivedRestaurantResult> {
  const riderId = text(riderIdValue).slice(0, 128);
  const orderId = text(orderIdValue).slice(0, 128);
  if (!riderId || !orderId) throw new DomainError("invalid-argument", "Rider and order are required.");

  const jobSnapshot = await db.ref(`${ROOT}/riderJobs/${riderId}/${orderId}`).get();
  const job = jobSnapshot.val() as Record<string, unknown> | null;
  const customerId = text(job?.customerId).slice(0, 128);
  if (!customerId) throw new DomainError("not-found", "Assigned delivery was not found.");
  const [orderSnapshot, riderSnapshot] = await Promise.all([
    db.ref(pathFor.order(customerId, orderId)).get(),
    db.ref(`${ROOT}/riders/${riderId}`).get(),
  ]);
  const order = orderSnapshot.val() as SavrivoOrder | null;
  if (!order || order.id !== orderId) throw new DomainError("not-found", "Assigned delivery was not found.");
  if (order.riderId !== riderId) throw new DomainError("permission-denied", "This delivery is assigned to another rider.");
  if (text((riderSnapshot.val() as Record<string, unknown> | null)?.status).toLowerCase() !== "approved") {
    throw new DomainError("permission-denied", "Your rider account is not approved for delivery actions.");
  }

  const arrivalRef = db.ref(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`);
  const existing = (await arrivalRef.get()).val() as StoredRiderArrivalRecord | null;
  if (isVerifiedRecord(existing)) {
    if (existing.riderId !== riderId || existing.restaurantId !== order.restaurantId) {
      throw new DomainError("failed-precondition", "Arrival was verified for another assignment.");
    }
    // A retry after pickup/handover is still a successful retry. Do not move a
    // completed rider projection back to at_restaurant.
    if (RESTAURANT_ARRIVAL_ORDER_STATUSES.has(order.status)) {
      await db.ref(ROOT).update(projectionUpdates(order, existing));
    }
    return result(existing, true);
  }

  const operationId = `arrival_${randomUUID()}`;
  const lease = await arrivalRef.transaction((current: StoredRiderArrivalRecord | null) => {
    if (isVerifiedRecord(current)) return undefined;
    if (current?.status === "verifying" && Number(current.leaseUntil ?? 0) > now) return undefined;
    return {
      version: 1,
      source: "server_verified_pickup_tracking",
      status: "verifying",
      orderId,
      riderId,
      operationId,
      leaseUntil: now + ARRIVAL_VERIFICATION_LEASE_MS,
      updatedAt: now,
    } satisfies PendingRiderArrivalRecord;
  }, undefined, false);
  if (!lease.committed) {
    const authoritative = lease.snapshot.val() as StoredRiderArrivalRecord | null;
    if (isVerifiedRecord(authoritative) && authoritative.riderId === riderId) {
      if (RESTAURANT_ARRIVAL_ORDER_STATUSES.has(order.status)) {
        await db.ref(ROOT).update(projectionUpdates(order, authoritative));
      }
      return result(authoritative, true);
    }
    if (isPendingRecord(authoritative)) {
      if (authoritative.riderId !== riderId) {
        throw new DomainError("failed-precondition", "Arrival was verified for another assignment.");
      }
      const resolved = await waitForPendingArrivalResolution(orderId, riderId, order.restaurantId);
      if (resolved) {
        if (RESTAURANT_ARRIVAL_ORDER_STATUSES.has(order.status)) {
          await db.ref(ROOT).update(projectionUpdates(order, resolved));
        }
        return result(resolved, true);
      }
    }
    throw new DomainError(
      "aborted",
      "Restaurant arrival is being checked. Keep the app open and retry in a few seconds.",
    );
  }

  try {
    // Re-read all authority after obtaining the lease. No client-supplied
    // coordinates, restaurant ID, customer ID or rider assignment is trusted.
    const [latestJobSnapshot, latestOrderSnapshot, latestRiderSnapshot, trackingSnapshot, presenceSnapshot] = await Promise.all([
      db.ref(`${ROOT}/riderJobs/${riderId}/${orderId}`).get(),
      db.ref(pathFor.order(customerId, orderId)).get(),
      db.ref(`${ROOT}/riders/${riderId}`).get(),
      db.ref(`${ROOT}/tracking/${orderId}`).get(),
      db.ref(`${ROOT}/riderPresence/${riderId}`).get(),
    ]);
    const latestJob = latestJobSnapshot.val() as Record<string, unknown> | null;
    const latestOrder = latestOrderSnapshot.val() as SavrivoOrder | null;
    const riderStatus = text((latestRiderSnapshot.val() as Record<string, unknown> | null)?.status).toLowerCase();
    if (!latestJob || text(latestJob.customerId) !== customerId || latestJob.status !== "active" ||
      !latestOrder || latestOrder.id !== orderId || latestOrder.riderId !== riderId || riderStatus !== "approved") {
      throw new DomainError("permission-denied", "This rider is not eligible to record arrival for the delivery.");
    }
    const decision = verifyRiderRestaurantArrival(
      latestOrder,
      riderId,
      trackingSnapshot.val(),
      now,
      presenceSnapshot.val(),
    );
    if (!decision.ok) {
      const code = decision.reason === "ORDER_NOT_ASSIGNED_TO_RIDER" ? "permission-denied" : "failed-precondition";
      throw new DomainError(code, "Restaurant arrival could not be verified.", {reason: decision.reason});
    }
    const record: RiderArrivalRecord = {
      version: 1,
      source: decision.source,
      status: "verified",
      orderId,
      restaurantId: latestOrder.restaurantId,
      riderId,
      arrivedAt: now,
      verifiedAt: now,
      ...decision.evidence,
    };
    await db.ref(ROOT).update(projectionUpdates(latestOrder, record));
    return result(record, false);
  } catch (error) {
    await releaseLease(orderId, riderId, operationId).catch(() => undefined);
    throw error;
  }
}
