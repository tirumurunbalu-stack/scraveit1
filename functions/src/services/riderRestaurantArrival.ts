import {randomUUID} from "node:crypto";
import {db, firestoreDb} from "../admin";
import {ROOT} from "../config";
import {
  RESTAURANT_ARRIVAL_ORDER_STATUSES,
  verifyRiderRestaurantArrival,
  type RiderRestaurantArrivalEvidence,
  type RiderRestaurantArrivalEvidenceSource,
} from "../domain/riderRestaurantArrival";
import {DomainError} from "../errors";
import type {DocumentReferenceLike, FirestoreLike, TransactionLike} from "../firestoreTypes";
import {orderRef, restaurantOrderProjectionRef, riderJobRef, riderRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";
import {applyRiderArrivalToOperationalProjection} from "./operationalOrders";

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

function riderArrivalRef(database: FirestoreLike, orderId: string): DocumentReferenceLike {
  return database.collection("riderRestaurantArrivals").doc(orderId);
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
  const ref = riderArrivalRef(firestoreDb, orderId);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ARRIVAL_VERIFICATION_POLL_MS));
    const snapshot = await ref.get();
    const current = snapshot.exists ? snapshot.data() as StoredRiderArrivalRecord : null;
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
  const snapshot = await riderArrivalRef(firestoreDb, order.id).get();
  const stored = snapshot.exists ? snapshot.data() : null;
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

/**
 * Reconciles the Rider job and Admin operational projections once arrival is
 * verified. The `restaurantOrders` denormalized mirror this used to also
 * patch is gone - `notifications.ts` is the collection's last reader, and
 * once it converts the collection itself goes away.
 */
async function reconcileArrivalProjections(order: SavrivoOrder, record: RiderArrivalRecord): Promise<void> {
  if (!RESTAURANT_ARRIVAL_ORDER_STATUSES.has(order.status)) return;
  const boundedVerification = {
    verified: true,
    verifiedAt: record.verifiedAt,
    distanceMeters: record.distanceMeters,
    accuracyMeters: record.accuracyMeters,
    source: record.source,
  };
  await Promise.all([
    riderJobRef(firestoreDb, record.riderId, order.id).update({
      phase: "at_restaurant",
      arrivedRestaurantAt: record.arrivedAt,
      arrivalVerification: boundedVerification,
      updatedAt: record.verifiedAt,
    }),
    applyRiderArrivalToOperationalProjection(order.id, record.arrivedAt),
    // The restaurant app reads `restaurantOrders`, not the canonical `orders`
    // doc (see buildRestaurantOrderProjection's comment) - without this write
    // the restaurant never sees riderArrivalVerified flip to true, so
    // "Confirm handover to rider" never unlocks no matter how long the rider
    // actually waits at the restaurant. This was dropped when this file
    // moved off RTDB; nothing surfaced it because every other read of arrival
    // state (riderJobs, operationalOrders) still worked.
    restaurantOrderProjectionRef(firestoreDb, order.restaurantId, order.customerId, order.id).set({
      riderArrivalVerified: true,
      riderArrivedRestaurantAt: record.arrivedAt,
      riderArrivalVerification: boundedVerification,
    }, {merge: true}),
  ]);
}

async function releaseLease(orderId: string, riderId: string, operationId: string): Promise<void> {
  const ref = riderArrivalRef(firestoreDb, orderId);
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as StoredRiderArrivalRecord : null;
    if (current?.status === "verifying" && current.riderId === riderId && current.operationId === operationId) {
      transaction.delete(ref);
    }
  });
}

/**
 * Verifies pickup arrival from fresh server-visible tracking. The final
 * evidence record and the Rider/Admin projections are committed together.
 * A short per-order lease makes concurrent/retried button presses converge
 * safely.
 */
export async function markRiderArrivedRestaurant(
  riderIdValue: unknown,
  orderIdValue: unknown,
  now = Date.now(),
): Promise<MarkRiderArrivedRestaurantResult> {
  const riderId = text(riderIdValue).slice(0, 128);
  const orderId = text(orderIdValue).slice(0, 128);
  if (!riderId || !orderId) throw new DomainError("invalid-argument", "Rider and order are required.");

  const jobSnapshot = await riderJobRef(firestoreDb, riderId, orderId).get();
  const job = jobSnapshot.exists ? jobSnapshot.data() as Record<string, unknown> : null;
  const customerId = text(job?.customerId).slice(0, 128);
  if (!customerId) throw new DomainError("not-found", "Assigned delivery was not found.");
  const [orderSnapshot, riderSnapshot] = await Promise.all([
    orderRef(firestoreDb, orderId).get(),
    riderRef(firestoreDb, riderId).get(),
  ]);
  const order = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
  if (!order || order.id !== orderId) throw new DomainError("not-found", "Assigned delivery was not found.");
  if (order.riderId !== riderId) throw new DomainError("permission-denied", "This delivery is assigned to another rider.");
  if (text((riderSnapshot.exists ? riderSnapshot.data() as Record<string, unknown> : null)?.status).toLowerCase() !== "approved") {
    throw new DomainError("permission-denied", "Your rider account is not approved for delivery actions.");
  }

  const arrivalRef = riderArrivalRef(firestoreDb, orderId);
  const existingSnapshot = await arrivalRef.get();
  const existing = existingSnapshot.exists ? existingSnapshot.data() as StoredRiderArrivalRecord : null;
  if (isVerifiedRecord(existing)) {
    if (existing.riderId !== riderId || existing.restaurantId !== order.restaurantId) {
      throw new DomainError("failed-precondition", "Arrival was verified for another assignment.");
    }
    // A retry after pickup/handover is still a successful retry. Do not move a
    // completed rider projection back to at_restaurant.
    await reconcileArrivalProjections(order, existing);
    return result(existing, true);
  }

  const operationId = `arrival_${randomUUID()}`;
  let leaseCommitted = false;
  const lease = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(arrivalRef);
    const current = snapshot.exists ? snapshot.data() as StoredRiderArrivalRecord : null;
    if (isVerifiedRecord(current)) return current;
    if (current?.status === "verifying" && Number(current.leaseUntil ?? 0) > now) return current;
    const pending: PendingRiderArrivalRecord = {
      version: 1,
      source: "server_verified_pickup_tracking",
      status: "verifying",
      orderId,
      riderId,
      operationId,
      leaseUntil: now + ARRIVAL_VERIFICATION_LEASE_MS,
      updatedAt: now,
    };
    transaction.set(arrivalRef, pending);
    leaseCommitted = true;
    return pending;
  });
  if (!leaseCommitted) {
    const authoritative = lease;
    if (isVerifiedRecord(authoritative) && authoritative.riderId === riderId) {
      await reconcileArrivalProjections(order, authoritative);
      return result(authoritative, true);
    }
    if (isPendingRecord(authoritative)) {
      if (authoritative.riderId !== riderId) {
        throw new DomainError("failed-precondition", "Arrival was verified for another assignment.");
      }
      const resolved = await waitForPendingArrivalResolution(orderId, riderId, order.restaurantId);
      if (resolved) {
        await reconcileArrivalProjections(order, resolved);
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
    // `tracking` and `riderPresence` still read from RTDB - dispatch.ts's
    // presence-write side has not converted yet.
    const [latestJobSnapshot, latestOrderSnapshot, latestRiderSnapshot, trackingSnapshot, presenceSnapshot] = await Promise.all([
      riderJobRef(firestoreDb, riderId, orderId).get(),
      orderRef(firestoreDb, orderId).get(),
      riderRef(firestoreDb, riderId).get(),
      db.ref(`${ROOT}/tracking/${orderId}`).get(),
      db.ref(`${ROOT}/riderPresence/${riderId}`).get(),
    ]);
    const latestJob = latestJobSnapshot.exists ? latestJobSnapshot.data() as Record<string, unknown> : null;
    const latestOrder = latestOrderSnapshot.exists ? latestOrderSnapshot.data() as SavrivoOrder : null;
    const riderStatus = text(
      (latestRiderSnapshot.exists ? latestRiderSnapshot.data() as Record<string, unknown> : null)?.status,
    ).toLowerCase();
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
    await arrivalRef.set(record);
    await reconcileArrivalProjections(latestOrder, record);
    return result(record, false);
  } catch (error) {
    await releaseLease(orderId, riderId, operationId).catch(() => undefined);
    throw error;
  }
}
