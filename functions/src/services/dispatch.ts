import {getFunctions} from "firebase-admin/functions";
import {logger} from "firebase-functions";
import {db, firestoreDb} from "../admin";
import {
  DISPATCH_RECOVERY_SCAN_INTERVAL_MS,
  REGION,
  ROOT,
} from "../config";
import {haversineKm, roundMoney} from "../domain/order";
import {
  buildLifecycleMutation,
  deriveLifecycle,
  deriveLifecycleFromCanonicalState,
} from "../domain/lifecycle";
import {
  availabilityCityKey,
  isEarlyDispatchWorkloadEligible,
  isDispatchPresenceEligible,
  isDispatchPresenceSearchable,
  isValidDispatchCoordinate,
  riderBecameDispatchEligible,
  riderBecameDispatchSearchable,
  wasRecentlyOffered,
} from "../domain/dispatch";
import {
  findNextDispatchWave,
  normalizeDispatchPolicy,
  type DispatchPolicy,
} from "../domain/dispatchPolicy";
import {
  isRiderDispatchEligibilityProjectionUsable,
  type RiderDispatchEligibilityProjection,
} from "../domain/riderEligibility";
import {
  buildRiderClaimRecoveryQueueCandidate,
  decideExpiredRiderClaimRecovery,
  type RiderClaimRecoveryAction,
  type RiderClaimQueueLike,
} from "../domain/riderClaimRecovery";
export {
  availabilityCityKey,
  activeDispatchJobs,
  isEarlyDispatchWorkloadEligible,
  isDispatchPresenceEligible,
  isDispatchPresenceSearchable,
  isValidDispatchCoordinate,
  riderBecameDispatchEligible,
  riderBecameDispatchSearchable,
  wasRecentlyOffered,
} from "../domain/dispatch";
import {stripPrivateOrderFields} from "../domain/orderSecurity";
import {buildRiderJobProjection, riderOfferPayout, riderPayoutBreakdown} from "../domain/riderJob";
import {DomainError} from "../errors";
import type {DocumentReferenceLike, FirestoreLike, TransactionLike, WriteBatchLike} from "../firestoreTypes";
import {
  dispatchQueueCollectionRef,
  dispatchQueueRef,
  orderRef,
  restaurantRef,
  riderAvailabilityCollectionRef,
  riderAvailabilityRef,
  riderJobRef,
  riderJobsCollectionRef,
  riderWalletRef,
} from "../firestorePaths";
import type {
  CatalogRestaurant,
  DispatchOffer,
  DispatchQueueRecord,
  RiderCandidate,
  SavrivoOrder,
  StatusEvent,
} from "../types";
import {requireApprovedRider} from "./authz";
import {notifyCustomerRiderAssigned, notifyRiderOffer, stopRiderOffers} from "./notifications";
import {reconcileRestaurantOrderProjection} from "./orderProjection";
import {loadDispatchPolicy} from "./platformConfig";
import {refreshRiderDispatchEligibility, riderDispatchEligibilityCollectionRef} from "./riderEligibility";
import {recordRiderRewardOrderAccepted, recordRiderRewardOrderRejected} from "./riderRewards";
import {riderPublicStats} from "./riderDeliveryCount";
import {riderRegistrationRequired} from "./taxEngine";

export interface Presence {
  online?: boolean;
  riderId?: string;
  riderName?: string;
  updatedAt?: number;
  lat?: number;
  lng?: number;
  accuracy?: number;
  activeOrderId?: string;
  city?: string;
}

interface RiderJob {
  status?: string;
  orderStatus?: string;
  phase?: string;
}

type QueueWithOfferData = DispatchQueueRecord & {
  id: string;
  active: boolean;
  restaurantAddress: string;
  restaurantLat: number;
  restaurantLng: number;
  approximateDropZone: string;
  itemCount: number;
  payout: number;
  payoutBreakdown?: {tripPay: number; incentives: number; tip: number; total: number};
  estimatedMinutes: number;
  restaurantArea: string;
  offeredRiderId?: string;
  distanceKm?: number;
  distanceSource?: "gps_straight_line";
};

// Start reserving a rider as soon as the restaurant accepts the order. The
// canonical order keeps its kitchen status until it becomes ready; the rider
// receives an Assigned projection and cannot complete pickup before handover.
const DISPATCH_ELIGIBLE_STATUSES = new Set(["Accepted", "Preparing", "Ready for pickup"]);
function objectMap<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" ? value as Record<string, T> : {};
}

function riderOfferRef(database: FirestoreLike, riderId: string, orderId: string): DocumentReferenceLike {
  return database.collection("riderOffers").doc(`${riderId}_${orderId}`);
}

function dispatchRecoveryScanLeaseRef(database: FirestoreLike): DocumentReferenceLike {
  return database.collection("private").doc("dispatchRecoveryScanLease");
}

export async function updateRiderAvailabilityIndex(
  riderId: string,
  before: Presence | null,
  after: Presence | null,
): Promise<void> {
  const ref = riderAvailabilityRef(firestoreDb, riderId);
  if (after?.online === true && Number.isFinite(Number(after.lat)) && Number.isFinite(Number(after.lng))) {
    // One document per rider, not a city-sharded path - a city change is just
    // an overwrite of this same document, replacing the old shard's
    // delete-plus-write pair the RTDB index used to need.
    await ref.set({
      riderId,
      riderName: String(after.riderName ?? "Savrivo Partner").slice(0, 120),
      city: String(after.city ?? "").slice(0, 120),
      cityKey: availabilityCityKey(after.city),
      online: true,
      lat: Number(after.lat),
      lng: Number(after.lng),
      ...(Number.isFinite(Number(after.accuracy)) ? {accuracy: Number(after.accuracy)} : {}),
      updatedAt: Number(after.updatedAt ?? Date.now()),
      ...(after.activeOrderId ? {activeOrderId: String(after.activeOrderId)} : {}),
    });
    return;
  }
  if (before) await ref.delete();
}

async function scheduleTimeout(orderId: string, attempt: number, delaySeconds: number): Promise<void> {
  await getFunctions().taskQueue(`locations/${REGION}/functions/dispatchOfferTimeout`).enqueue(
    {orderId, attempt},
    {scheduleDelaySeconds: delaySeconds},
  );
}

export async function scheduleDispatchClaimRecovery(
  orderId: string,
  operationId: string,
  leaseUntil: number,
): Promise<void> {
  const delaySeconds = Math.max(1, Math.ceil((leaseUntil - Date.now()) / 1000) + 2);
  await getFunctions().taskQueue(`locations/${REGION}/functions/dispatchClaimRecoveryTask`).enqueue(
    {orderId, operationId},
    {scheduleDelaySeconds: delaySeconds},
  );
}

async function candidatesFor(
  order: SavrivoOrder,
  policy: DispatchPolicy,
  attemptedRiders: Record<string, number> = {},
): Promise<RiderCandidate[]> {
  const restaurantSnapshot = await restaurantRef(firestoreDb, order.restaurantId).get();
  const restaurant = restaurantSnapshot.exists ? restaurantSnapshot.data() as CatalogRestaurant : null;
  const cityKey = availabilityCityKey(restaurant?.city);
  const presenceSnapshot = await riderAvailabilityCollectionRef(firestoreDb).where("cityKey", "==", cityKey).limit(500).get();
  let presences: Record<string, Presence> = {};
  for (const doc of presenceSnapshot.docs) presences[doc.id] = doc.data() as Presence;
  // Compatibility fallback while the index is being populated by rider
  // heartbeats after first deployment. It is hard-capped and should disappear
  // after the rollout/backfill is complete. Still reads RTDB directly: the
  // raw per-rider presence record itself (written straight from the rider
  // app) has not migrated off RTDB yet.
  if (presenceSnapshot.empty) {
    const fallbackSnapshot = await db.ref(`${ROOT}/riderPresence`).limitToFirst(500).get();
    presences = objectMap<Presence>(fallbackSnapshot.val());
  }
  const eligibilityByRider: Record<string, RiderDispatchEligibilityProjection> = {};
  const now = Date.now();
  const rejected = {offline: 0, stale: 0, location: 0, accuracy: 0, distance: 0, busy: 0, cooldown: 0};
  let eligibilityProjectionHits = 0;
  let eligibilityProjectionFallbacks = 0;
  let eligibilityProjectionMissing = 0;
  let eligibilityProjectionStale = 0;
  const nearestPresence = Object.entries(presences).flatMap(([riderId, presence]) => {
    const lat = Number(presence?.lat);
    const lng = Number(presence?.lng);
    if (presence?.online !== true) { rejected.offline++; return []; }
    if (now - Number(presence.updatedAt ?? 0) > policy.presenceFreshMs) { rejected.stale++; return []; }
    if (!isValidDispatchCoordinate(lat, lng)) { rejected.location++; return []; }
    // Workload is verified from the authoritative riderJobs projection below.
    // A presence activeOrderId alone must not delay the next offer when that
    // delivery has already reached the customer's doorstep.
    if (!isDispatchPresenceEligible({...presence, activeOrderId: undefined}, now, {
      presenceFreshMs: policy.presenceFreshMs,
      maxLocationAccuracyMeters: policy.maxLocationAccuracyMeters,
    })) { rejected.accuracy++; return []; }
    if (wasRecentlyOffered(attemptedRiders[riderId], now, policy.reofferCooldownMs)) { rejected.cooldown++; return []; }
    const distanceKm = haversineKm({lat, lng}, order.restaurantLocation);
    if (!Number.isFinite(distanceKm) || distanceKm > policy.maxRadiusKm) {
      rejected.distance++;
      return [];
    }
    return [{riderId, presence, distanceKm}];
  }).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 100);
  // Eligibility for just these nearest riders, not the first 500 riders of
  // the whole platform. The cache must never become a dispatch dependency:
  // a failed read falls back to authoritative per-rider hydration below.
  await Promise.all(nearestPresence.map(async ({riderId}) => {
    try {
      const snapshot = await riderDispatchEligibilityCollectionRef(firestoreDb).doc(riderId).get();
      if (snapshot.exists) eligibilityByRider[riderId] = snapshot.data() as RiderDispatchEligibilityProjection;
    } catch (error) {
      logger.warn("RIDER_ELIGIBILITY_PROJECTION_READ_FAILED", {orderId: order.id, riderId, error});
    }
  }));
  const hydrated = await Promise.all(nearestPresence.map(async ({riderId, presence, distanceKm}) => {
    const cachedEligibility = eligibilityByRider[riderId];
    const projectionUsable = isRiderDispatchEligibilityProjectionUsable(cachedEligibility, riderId, now);
    const repairBusyProjection = projectionUsable && shouldForceEligibilityRepair(cachedEligibility, presence);
    const eligibility = projectionUsable && !repairBusyProjection
      ? cachedEligibility
      : await refreshRiderDispatchEligibility(riderId, now, {
        forceWorkloadRebuild: repairBusyProjection,
      });
    if (projectionUsable && !repairBusyProjection) {
      eligibilityProjectionHits++;
    } else {
      eligibilityProjectionFallbacks++;
      if (cachedEligibility) eligibilityProjectionStale++;
      else eligibilityProjectionMissing++;
    }
    if (!eligibility.approved || eligibility.codBlocked || eligibility.orderBlocked) return null;
    if (!eligibility.workloadEligible) { rejected.busy++; return null; }
    return {
      riderId,
      riderName: String(eligibility.riderName || presence.riderName || "Savrivo Partner"),
      distanceKm,
      activeLoad: eligibility.activeLoad,
    };
  }));
  const ranked = hydrated.filter((entry): entry is Omit<RiderCandidate, "score"> => entry !== null)
    .map((candidate): RiderCandidate => ({
      ...candidate,
      score: roundMoney(candidate.distanceKm + candidate.activeLoad * policy.fairnessLoadPenaltyKm),
    }))
    .sort((a, b) => a.score - b.score || a.distanceKm - b.distanceKm || a.riderId.localeCompare(b.riderId))
    .slice(0, policy.maxCandidates);
  logger.info("RIDER_CANDIDATES_RANKED", {
    orderId: order.id,
    restaurantId: order.restaurantId,
    cityKey,
    indexedPresenceCount: Object.keys(presences).length,
    eligibleCount: ranked.length,
    policyVersion: policy.version,
    policyMode: policy.mode,
    eligibilityProjectionHits,
    eligibilityProjectionFallbacks,
    eligibilityProjectionMissing,
    eligibilityProjectionStale,
    rejected,
    ranked: ranked.map(({riderId, distanceKm, activeLoad}) => ({riderId, distanceKm: Number(distanceKm.toFixed(2)), activeLoad})),
  });
  return ranked;
}

function policyForQueue(queue: QueueWithOfferData | null | undefined): DispatchPolicy {
  return normalizeDispatchPolicy(queue?.policySnapshot);
}

function shouldForceEligibilityRepair(
  cachedEligibility: RiderDispatchEligibilityProjection | undefined,
  presence: Presence,
): boolean {
  return Boolean(
    cachedEligibility &&
    cachedEligibility.approved === true &&
    cachedEligibility.codBlocked !== true &&
    cachedEligibility.orderBlocked !== true &&
    cachedEligibility.workloadEligible !== true &&
    !String(presence.activeOrderId ?? "").trim(),
  );
}

function activeOfferForRider(
  queue: QueueWithOfferData | null | undefined,
  riderId: string,
): DispatchOffer | undefined {
  if (!queue) return undefined;
  return queue.activeOffers?.[riderId] ??
    (queue.currentOffer?.riderId === riderId ? queue.currentOffer : undefined);
}

function activeOfferEntries(queue: QueueWithOfferData | null | undefined): Array<[string, DispatchOffer]> {
  if (!queue) return [];
  const entries = Object.entries(queue.activeOffers ?? {});
  if (entries.length) return entries;
  return queue.currentOffer ? [[queue.currentOffer.riderId, queue.currentOffer]] : [];
}

function offersForWave(
  candidates: readonly RiderCandidate[],
  wave: number,
  now: number,
  timeoutSeconds: number,
): Record<string, DispatchOffer> {
  const expiresAt = now + timeoutSeconds * 1000;
  return Object.fromEntries(candidates.map((candidate) => [candidate.riderId, {
    riderId: candidate.riderId,
    offeredAt: now,
    expiresAt,
    wave,
  }]));
}

function riderOfferRecord(queue: QueueWithOfferData, riderId: string): Record<string, unknown> {
  const offer = activeOfferForRider(queue, riderId);
  const candidate = queue.candidates.find((entry) => entry.riderId === riderId);
  return {
    id: queue.id,
    // Not read by any server code (the doc id `${riderId}_${orderId}` already
    // scopes it) - needed only so the rider app's own client-side Firestore
    // rules/query (`where("riderId","==",uid)`) can find its own offers.
    riderId,
    orderId: queue.orderId,
    restaurantId: queue.restaurantId,
    restaurantName: queue.restaurantName,
    restaurantAddress: queue.restaurantAddress,
    restaurantArea: queue.restaurantArea,
    restaurantLat: queue.restaurantLat,
    restaurantLng: queue.restaurantLng,
    approximateDropZone: queue.approximateDropZone,
    itemCount: queue.itemCount,
    payout: queue.payout,
    ...(queue.payoutBreakdown ? {payoutBreakdown: queue.payoutBreakdown} : {}),
    estimatedMinutes: queue.estimatedMinutes,
    kitchenStatus: queue.kitchenStatus,
    active: true,
    status: "offering",
    currentOffer: offer ?? queue.currentOffer,
    distanceKm: candidate ? Number(candidate.distanceKm.toFixed(2)) : queue.distanceKm ?? null,
    distanceSource: queue.distanceSource ?? "gps_straight_line",
    createdAt: queue.createdAt,
    updatedAt: queue.updatedAt,
  };
}

async function clearRiderOfferRecords(riderIds: string[], orderId: string): Promise<void> {
  const ids = [...new Set(riderIds.filter(Boolean))];
  if (!ids.length) return;
  const batch: WriteBatchLike = firestoreDb.batch();
  for (const riderId of ids) batch.delete(riderOfferRef(firestoreDb, riderId, orderId));
  await batch.commit();
}

function allOfferedRiderIds(queue: QueueWithOfferData | null | undefined): string[] {
  return [...new Set([
    ...(queue?.candidates ?? []).map((candidate) => candidate.riderId),
    ...Object.keys(queue?.attemptedRiders ?? {}),
    ...Object.keys(queue?.activeOffers ?? {}),
    queue?.currentOffer?.riderId ?? "",
  ].filter(Boolean))];
}

export async function beginSequentialDispatch(order: SavrivoOrder): Promise<QueueWithOfferData | null> {
  if (!DISPATCH_ELIGIBLE_STATUSES.has(order.status) || order.riderId) return null;
  const ref = dispatchQueueRef(firestoreDb, order.id);
  const previousSnapshot = await ref.get();
  const previous = previousSnapshot.exists ? previousSnapshot.data() as QueueWithOfferData : null;
  const priorAttempts = previous?.attemptedRiders ?? {};
  const policy = previous?.policySnapshot ? policyForQueue(previous) : await loadDispatchPolicy();
  const candidates = await candidatesFor(order, policy, priorAttempts);
  const now = Date.now();
  const wave = findNextDispatchWave(candidates, priorAttempts, policy, 0);
  const selected = wave?.candidates ?? [];
  const activeOffers = offersForWave(
    selected,
    wave?.wave ?? 0,
    now,
    policy.offerTimeoutSeconds,
  );
  const first = selected[0];
  const attempt = previous ? Number(previous.attempt ?? -1) + 1 : 0;
  const attemptedRiders = {...priorAttempts};
  selected.forEach((candidate) => { attemptedRiders[candidate.riderId] = now; });
  const queue: QueueWithOfferData = {
    id: order.id,
    orderId: order.id,
    customerId: order.customerId,
    restaurantId: order.restaurantId,
    restaurantName: order.restaurant,
    candidates,
    attempt,
    ...(first ? {currentOffer: activeOffers[first.riderId]} : {}),
    ...(first ? {activeOffers} : {}),
    ...(wave ? {wave: wave.wave} : {}),
    policySnapshot: {...policy},
    status: first ? "offering" : "exhausted",
    attemptedRiders,
    metrics: {
      offered: Number(previous?.metrics?.offered ?? 0) + selected.length,
      accepted: Number(previous?.metrics?.accepted ?? 0),
      rejected: Number(previous?.metrics?.rejected ?? 0),
      expired: Number(previous?.metrics?.expired ?? 0),
      startedAt: Number(previous?.metrics?.startedAt ?? now),
    },
    createdAt: Number(previous?.createdAt ?? now),
    updatedAt: now,
    active: Boolean(first),
    restaurantAddress: order.restaurantLocation.address,
    restaurantArea: order.restaurantLocation.address,
    restaurantLat: order.restaurantLocation.lat,
    restaurantLng: order.restaurantLocation.lng,
    approximateDropZone: order.address.area || order.address.city || "Service area",
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    payout: riderOfferPayout(order),
    payoutBreakdown: riderPayoutBreakdown(order),
    estimatedMinutes: order.etaMax,
    kitchenStatus: order.status,
    ...(first ? {offeredRiderId: first.riderId} : {}),
    ...(first ? {distanceKm: Number(first.distanceKm.toFixed(2))} : {}),
    ...(first ? {distanceSource: "gps_straight_line" as const} : {}),
  };
  let committed = false;
  const activeQueue = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as QueueWithOfferData : null;
    if (current && ["offering", "assigned"].includes(current.status)) return current;
    transaction.set(ref, queue);
    committed = true;
    return queue;
  });
  logger.info("DISPATCH_STARTED", {
    orderId: order.id,
    restaurantId: order.restaurantId,
    candidateCount: candidates.length,
    status: activeQueue?.status ?? "not_committed",
    riderId: activeQueue?.currentOffer?.riderId ?? "",
    policyVersion: activeQueue?.policySnapshot?.version ?? policy.version,
    policyMode: activeQueue?.policySnapshot?.mode ?? policy.mode,
    wave: activeQueue?.wave ?? 0,
    offeredRiderCount: activeOfferEntries(activeQueue).length,
  });
  if (activeQueue?.status === "offering" && activeQueue.currentOffer) {
    // Enqueuing duplicate timeout tasks is safe: each task carries the expected
    // attempt and the queue transaction rejects stale attempts.
    const activePolicy = policyForQueue(activeQueue);
    await scheduleTimeout(order.id, activeQueue.attempt, activePolicy.offerTimeoutSeconds);
    if (committed) {
      await Promise.all(activeOfferEntries(activeQueue).map(async ([riderId, offer]) => {
        await riderOfferRef(firestoreDb, riderId, order.id).set(riderOfferRecord(activeQueue, riderId));
        logger.info("RIDER_OFFER_SENT", {
          orderId: order.id,
          riderId,
          attempt: activeQueue.attempt,
          wave: offer.wave ?? activeQueue.wave ?? 0,
        });
        await notifyRiderOffer(riderId, order, offer.expiresAt)
          .catch((error) => logger.error("Initial rider offer notification failed", {orderId: order.id, riderId, error}));
      }));
    }
  }
  return activeQueue;
}

export async function advanceDispatchOffer(orderId: string, expectedAttempt: number): Promise<void> {
  const ref = dispatchQueueRef(firestoreDb, orderId);
  let previousRiderIds: string[] = [];
  let nextRiderIds: string[] = [];
  let nextAttempt = expectedAttempt;
  let committed = false;
  const queue = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as QueueWithOfferData : null;
    const currentOffers = activeOfferEntries(current);
    if (!current || current.status !== "offering" || current.claim || current.attempt !== expectedAttempt ||
      !currentOffers.length || currentOffers.some(([, offer]) => offer.expiresAt > Date.now())) return current;
    previousRiderIds = currentOffers.map(([riderId]) => riderId);
    nextAttempt = expectedAttempt + 1;
    const now = Date.now();
    const policy = policyForQueue(current);
    const nextWave = findNextDispatchWave(
      current.candidates,
      current.attemptedRiders ?? {},
      policy,
      Number(current.wave ?? -1) + 1,
    );
    let next: QueueWithOfferData;
    if (!nextWave) {
      const {currentOffer: _offer, activeOffers: _offers, offeredRiderId: _offered, ...rest} = current;
      next = {
        ...rest,
        status: "exhausted",
        active: false,
        attempt: nextAttempt,
        updatedAt: now,
        metrics: {
          offered: Number(current.metrics?.offered ?? 0),
          accepted: Number(current.metrics?.accepted ?? 0),
          rejected: Number(current.metrics?.rejected ?? 0),
          expired: Number(current.metrics?.expired ?? 0) + previousRiderIds.length,
          startedAt: Number(current.metrics?.startedAt ?? current.createdAt ?? now),
        },
      };
    } else {
      const activeOffers = offersForWave(
        nextWave.candidates,
        nextWave.wave,
        now,
        policy.offerTimeoutSeconds,
      );
      const primary = nextWave.candidates[0]!;
      nextRiderIds = nextWave.candidates.map((candidate) => candidate.riderId);
      const attemptedRiders = {...(current.attemptedRiders ?? {})};
      nextWave.candidates.forEach((candidate) => { attemptedRiders[candidate.riderId] = now; });
      next = {
        ...current,
        attempt: nextAttempt,
        wave: nextWave.wave,
        currentOffer: activeOffers[primary.riderId],
        activeOffers,
        offeredRiderId: primary.riderId,
        distanceKm: Number(primary.distanceKm.toFixed(2)),
        distanceSource: "gps_straight_line" as const,
        attemptedRiders,
        updatedAt: now,
        metrics: {
          offered: Number(current.metrics?.offered ?? 0) + nextWave.candidates.length,
          accepted: Number(current.metrics?.accepted ?? 0),
          rejected: Number(current.metrics?.rejected ?? 0),
          expired: Number(current.metrics?.expired ?? 0) + previousRiderIds.length,
          startedAt: Number(current.metrics?.startedAt ?? current.createdAt ?? now),
        },
      };
    }
    transaction.set(ref, next);
    committed = true;
    return next;
  });
  if (!committed || !queue) return;
  if (previousRiderIds.length) await clearRiderOfferRecords(previousRiderIds, orderId);
  if (previousRiderIds.length) {
    await stopRiderOffers(previousRiderIds, orderId, "")
      .catch((error) => logger.warn("Expired rider offer removal failed", {orderId, riderIds: previousRiderIds, error}));
  }
  if (queue.status !== "offering" || !nextRiderIds.length) return;
  const orderSnapshot = await orderRef(firestoreDb, orderId).get();
  const order = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
  if (!order || !DISPATCH_ELIGIBLE_STATUSES.has(order.status) || order.riderId) {
    await ref.update({status: "cancelled", active: false, updatedAt: Date.now()});
    return;
  }
  const policy = policyForQueue(queue);
  await scheduleTimeout(orderId, nextAttempt, policy.offerTimeoutSeconds);
  await Promise.all(nextRiderIds.map(async (riderId) => {
    const offer = activeOfferForRider(queue, riderId);
    if (!offer) return;
    await riderOfferRef(firestoreDb, riderId, orderId).set(riderOfferRecord(queue, riderId));
    logger.info("RIDER_OFFER_SENT", {orderId, riderId, attempt: nextAttempt, wave: offer.wave ?? queue.wave ?? 0});
    await notifyRiderOffer(riderId, order, offer.expiresAt)
      .catch((error) => logger.error("Rider offer notification failed", {orderId, riderId, error}));
  }));
}

async function releaseQueueClaim(queueRef: DocumentReferenceLike, uid: string): Promise<void> {
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(queueRef);
    const current = snapshot.exists ? snapshot.data() as QueueWithOfferData : null;
    if (current?.claim?.riderId === uid) transaction.set(queueRef, {...current, claim: null});
  });
}

export async function claimDispatchOffer(uid: string, orderId: string): Promise<SavrivoOrder> {
  const rider = await requireApprovedRider(uid);
  // Liable to register for GST but not registered: no deliveries (SCRAVEIT does not take on its GST).
  if (riderRegistrationRequired(rider)) {
    throw new DomainError("failed-precondition", "Add valid GST registration details before accepting deliveries.");
  }
  const queueRef = dispatchQueueRef(firestoreDb, orderId);
  const [presenceSnapshot, walletSnapshot, jobsSnapshot, queueSnapshot] = await Promise.all([
    db.ref(`${ROOT}/riderPresence/${uid}`).get(),
    riderWalletRef(firestoreDb, uid).get(),
    riderJobsCollectionRef(firestoreDb).where("riderId", "==", uid).get(),
    queueRef.get(),
  ]);
  const presence = presenceSnapshot.val() as Presence | null;
  const wallet = walletSnapshot.exists ? walletSnapshot.data() as {codBlocked?: boolean; orderBlocked?: boolean} : null;
  const jobs: Record<string, RiderJob> = {};
  for (const doc of jobsSnapshot.docs) jobs[doc.id] = doc.data() as RiderJob;
  const cachedQueue = queueSnapshot.exists ? queueSnapshot.data() as QueueWithOfferData : null;
  const policy = policyForQueue(cachedQueue);
  if (wallet?.codBlocked === true || wallet?.orderBlocked === true) {
    throw new DomainError("failed-precondition", "Resolve the rider account hold before accepting another order.");
  }
  if (!presence || !isDispatchPresenceEligible({...presence, activeOrderId: undefined}, Date.now(), {
    presenceFreshMs: policy.presenceFreshMs,
    maxLocationAccuracyMeters: policy.maxLocationAccuracyMeters,
  })) {
    throw new DomainError("failed-precondition", "Go online with current location before accepting an order.");
  }
  if (!Number.isFinite(Number(presence.lat)) || !Number.isFinite(Number(presence.lng))) {
    throw new DomainError("failed-precondition", "A current rider location is required to accept this order.");
  }
  if (!isEarlyDispatchWorkloadEligible(jobs)) {
    throw new DomainError("failed-precondition", "Finish the current delivery before accepting another order.");
  }
  const claimAt = Date.now();
  // A callable response can be lost after the order transaction commits. Treat a retry by the
  // same rider as success and repair the derived queue/job projections instead of reporting that
  // the rider lost an order they already own.
  if (cachedQueue?.claim?.riderId === uid) {
    const claimedOrderSnapshot = await orderRef(firestoreDb, orderId).get();
    const claimedOrder = claimedOrderSnapshot.exists ? claimedOrderSnapshot.data() as SavrivoOrder : null;
    if (claimedOrder?.riderId === uid) {
      return finalizeRiderAssignment(cachedQueue, stripPrivateOrderFields(claimedOrder), uid,
        Number(cachedQueue.claim.claimedAt ?? claimedOrder.riderAssignedAt ?? claimAt));
    }
  }
  const operationId = `claim_${orderId}_${uid}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 180);
  let queueCommitted = false;
  const queue = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(queueRef);
    const current = snapshot.exists ? snapshot.data() as QueueWithOfferData : null;
    const offer = activeOfferForRider(current, uid);
    if (!current || current.status !== "offering" || !offer || offer.expiresAt < claimAt) return current;
    if (current.claim && current.claim.riderId !== uid) return current;
    const next: QueueWithOfferData = {
      ...current,
      claim: {
        riderId: uid,
        claimedAt: Number(current.claim?.claimedAt ?? claimAt),
        operationId: String(current.claim?.operationId ?? operationId),
        leaseUntil: claimAt + policy.claimLeaseSeconds * 1000,
        state: current.claim?.state ?? "reserved",
      },
      updatedAt: claimAt,
    };
    transaction.set(queueRef, next);
    queueCommitted = true;
    return next;
  });
  if (!queueCommitted || !queue) throw new DomainError("aborted", "This delivery offer is no longer available.");
  const orderDocRef = orderRef(firestoreDb, orderId);
  const beforeSnapshot = await orderDocRef.get();
  const before = beforeSnapshot.exists ? beforeSnapshot.data() as SavrivoOrder : null;
  if (before?.riderId === uid) {
    return finalizeRiderAssignment(queue, stripPrivateOrderFields(before), uid,
      Number(queue.claim?.claimedAt ?? before.riderAssignedAt ?? claimAt));
  }
  if (!before || !DISPATCH_ELIGIBLE_STATUSES.has(before.status) || before.riderId) {
    await releaseQueueClaim(queueRef, uid);
    throw new DomainError("failed-precondition", "Order is no longer available for assignment.");
  }
  const event: StatusEvent = {status: "Assigned", at: claimAt, actorId: uid, actorRole: "rider"};
  const eventId = `e_${claimAt}_${uid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30)}`;
  const restaurantSnapshot = await restaurantRef(firestoreDb, before.restaurantId).get();
  const restaurant = restaurantSnapshot.exists ? restaurantSnapshot.data() as {phone?: string} : null;
  let orderCommitted = false;
  const order = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(orderDocRef);
    const orderValue = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
    if (!orderValue || orderValue.id !== before.id || orderValue.customerId !== before.customerId ||
      orderValue.restaurantId !== before.restaurantId || orderValue.createdAt !== before.createdAt ||
      !DISPATCH_ELIGIBLE_STATUSES.has(orderValue.status) || orderValue.riderId) return orderValue;
    const ready = orderValue.status === "Ready for pickup";
    const candidate: SavrivoOrder = {
      ...stripPrivateOrderFields(orderValue),
      riderId: uid,
      riderName: String(rider.fullName ?? presence.riderName ?? "Savrivo Partner"),
      ...(rider.phone ? {riderPhone: String(rider.phone).slice(0, 30)} : {}),
      ...riderPublicStats(rider),
      riderAssignedAt: claimAt,
      ...(restaurant?.phone ? {restaurantPhone: String(restaurant.phone).slice(0, 30)} : {}),
      status: ready ? "Assigned" : orderValue.status,
      updatedAt: claimAt,
      statusHistory: ready ? {...(orderValue.statusHistory ?? {}), [eventId]: event} : orderValue.statusHistory,
    };
    const lifecycle = buildLifecycleMutation(
      deriveLifecycle(orderValue),
      deriveLifecycleFromCanonicalState(candidate),
      claimAt,
    );
    const next = {...candidate, ...lifecycle.patch};
    transaction.set(orderDocRef, next);
    orderCommitted = true;
    return next;
  });
  if (!orderCommitted) {
    const authoritativeSnapshot = await orderDocRef.get();
    const authoritativeOrder = authoritativeSnapshot.exists ? authoritativeSnapshot.data() as SavrivoOrder : null;
    if (authoritativeOrder?.riderId === uid) {
      return finalizeRiderAssignment(
        queue,
        stripPrivateOrderFields(authoritativeOrder),
        uid,
        Number(queue.claim?.claimedAt ?? authoritativeOrder.riderAssignedAt ?? claimAt),
      );
    }
    await releaseQueueClaim(queueRef, uid);
    throw new DomainError("aborted", "Another rider secured this order.");
  }
  const finalOrder = stripPrivateOrderFields(order as SavrivoOrder);
  // Persist an explicit post-order-commit phase before repairing projections.
  // If the process dies after the canonical order transaction, the scheduled
  // recovery worker can distinguish a committed assignment from an abandoned
  // reservation without ever guessing from client state.
  let queueAfterOrderCommit = queue;
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(queueRef);
    const current = snapshot.exists ? snapshot.data() as QueueWithOfferData : null;
    if (!current?.claim || current.claim.riderId !== uid || current.claim.state === "finalized") {
      queueAfterOrderCommit = current ?? queue;
      return;
    }
    const next: QueueWithOfferData = {
      ...current,
      claim: {
        ...current.claim,
        state: "order_committed" as const,
        leaseUntil: Math.max(Number(current.claim.leaseUntil ?? 0), claimAt + policy.claimLeaseSeconds * 1000),
      },
      updatedAt: claimAt,
    };
    transaction.set(queueRef, next);
    queueAfterOrderCommit = next;
  });
  return finalizeRiderAssignment(queueAfterOrderCommit, finalOrder, uid, claimAt);
}

async function finalizeRiderAssignment(
  queue: QueueWithOfferData,
  order: SavrivoOrder,
  uid: string,
  claimAt: number,
): Promise<SavrivoOrder> {
  const currentPresence = (await db.ref(`${ROOT}/riderPresence/${uid}`).get()).val() as Presence | null;
  const activePresenceOrderId = String(currentPresence?.activeOrderId ?? "").trim() || order.id;
  const {currentOffer: _offer, activeOffers: _offers, offeredRiderId: _offered, ...restQueue} = queue;
  const nextQueue: QueueWithOfferData = {
    ...restQueue,
    status: "assigned",
    active: false,
    claim: {
      riderId: uid,
      claimedAt: Number(queue.claim?.claimedAt ?? claimAt),
      operationId: String(queue.claim?.operationId ?? `claim_${order.id}_${uid}`).slice(0, 180),
      leaseUntil: claimAt,
      state: "finalized",
    },
    metrics: {
      offered: Number(queue.metrics?.offered ?? 0),
      accepted: Math.max(1, Number(queue.metrics?.accepted ?? 0)),
      rejected: Number(queue.metrics?.rejected ?? 0),
      expired: Number(queue.metrics?.expired ?? 0),
      startedAt: Number(queue.metrics?.startedAt ?? queue.createdAt ?? claimAt),
      assignedAt: Number(queue.metrics?.assignedAt ?? claimAt),
    },
    updatedAt: claimAt,
  };
  await Promise.all([
    dispatchQueueRef(firestoreDb, order.id).set(nextQueue),
    riderJobRef(firestoreDb, uid, order.id).set(buildRiderJobProjection(order)),
    db.ref(`${ROOT}/riderPresence/${uid}/activeOrderId`).set(activePresenceOrderId),
  ]);
  await reconcileRestaurantOrderProjection(order);
  const offeredRiderIds = allOfferedRiderIds(queue);
  await clearRiderOfferRecords(offeredRiderIds, order.id);
  logger.info("RIDER_OFFER_ACCEPTED", {orderId: order.id, riderId: uid, attempt: queue.attempt});
  await recordRiderRewardOrderAccepted(uid, order.id, claimAt)
    .catch((error) => logger.warn("Reward acceptance tracking failed", {orderId: order.id, riderId: uid, error}));
  await stopRiderOffers(offeredRiderIds, order.id, uid)
    .catch((error) => logger.warn("Assigned rider offer removal failed", {orderId: order.id, riderId: uid, error}));
  await notifyCustomerRiderAssigned(order)
    .catch((error) => logger.warn("Customer rider-assigned notification failed", {orderId: order.id, riderId: uid, error}));
  return order;
}

export interface DispatchClaimRecoverySummary {
  inspected: number;
  recovered: number;
  finalized: number;
  released: number;
  cancelled: number;
  waiting: number;
  ignored: number;
  failed: number;
}

export type DispatchClaimRecoveryOutcome = RiderClaimRecoveryAction | "stale" | "failed";

/** Reconciles one claim task. Safe to invoke repeatedly and concurrently. */
export async function recoverDispatchClaim(
  orderId: string,
  expectedOperationId = "",
): Promise<DispatchClaimRecoveryOutcome> {
  const queueRef = dispatchQueueRef(firestoreDb, orderId);
  const rawQueueSnapshot = await queueRef.get();
  const rawQueue = rawQueueSnapshot.exists ? rawQueueSnapshot.data() as QueueWithOfferData : null;
  if (!rawQueue?.claim) return "none";
  if (expectedOperationId && String(rawQueue.claim.operationId ?? "") !== expectedOperationId) return "stale";
  const customerId = String(rawQueue.customerId ?? "");
  const queue: QueueWithOfferData = {...rawQueue, id: rawQueue.id ?? orderId, orderId};
  const orderSnapshot = customerId ? await orderRef(firestoreDb, orderId).get() : null;
  const order = orderSnapshot?.exists ? orderSnapshot.data() as SavrivoOrder : null;
  const plan = decideExpiredRiderClaimRecovery(queue as unknown as RiderClaimQueueLike, order, Date.now());
  if (plan.action === "wait_for_lease" || plan.action === "none") return plan.action;

  const offeredRiderIds = allOfferedRiderIds(queue);
  let committed = false;
  const committedQueue = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(queueRef);
    const current = snapshot.exists ? snapshot.data() as QueueWithOfferData : null;
    const next = buildRiderClaimRecoveryQueueCandidate(
      current as unknown as RiderClaimQueueLike | null,
      plan,
      Date.now(),
    ) as unknown as QueueWithOfferData | undefined;
    if (!next) return current;
    transaction.set(queueRef, next);
    committed = true;
    return next;
  });
  if (!committed || !committedQueue) {
    logger.info("RIDER_CLAIM_RECOVERY_STALE_PLAN_IGNORED", {orderId, recoveryId: plan.recoveryId});
    return "stale";
  }

  logger.warn("RIDER_CLAIM_RECOVERED", {
    orderId,
    recoveryId: plan.recoveryId,
    action: plan.action,
    reason: plan.reason,
    authoritativeRiderId: plan.authoritativeRiderId ?? "",
  });

  if (plan.action === "finalize_authoritative_assignment") {
    const authoritativeSnapshot = customerId ? await orderRef(firestoreDb, orderId).get() : null;
    const authoritativeOrder = authoritativeSnapshot?.exists ? authoritativeSnapshot.data() as SavrivoOrder : null;
    if (authoritativeOrder?.riderId !== plan.authoritativeRiderId || !plan.authoritativeRiderId) {
      logger.warn("RIDER_CLAIM_RECOVERY_ORDER_CHANGED_AFTER_COMMIT", {orderId, recoveryId: plan.recoveryId});
      return "stale";
    }
    await finalizeRiderAssignment(
      committedQueue,
      stripPrivateOrderFields(authoritativeOrder),
      plan.authoritativeRiderId,
      Number(plan.assignmentAt ?? authoritativeOrder.riderAssignedAt ?? Date.now()),
    );
    return plan.action;
  }

  await Promise.all([
    clearRiderOfferRecords(offeredRiderIds, orderId),
    stopRiderOffers(offeredRiderIds, orderId, ""),
  ]);
  if (plan.action === "release_for_redispatch") {
    const authoritativeSnapshot = customerId ? await orderRef(firestoreDb, orderId).get() : null;
    const authoritativeOrder = authoritativeSnapshot?.exists ? authoritativeSnapshot.data() as SavrivoOrder : null;
    if (authoritativeOrder && DISPATCH_ELIGIBLE_STATUSES.has(authoritativeOrder.status) && !authoritativeOrder.riderId) {
      await beginSequentialDispatch(authoritativeOrder);
    }
  }
  return plan.action;
}

/**
 * Repairs dispatch claims interrupted between reservation, canonical order
 * commit, and projection fan-out. The canonical order's riderId is the only
 * assignment authority; the queue transaction is fingerprint-fenced so an
 * old recovery run cannot overwrite a newer claim or winner.
 */
export async function recoverExpiredDispatchClaims(limitPerStatus = 100): Promise<DispatchClaimRecoverySummary> {
  const boundedLimit = Math.max(1, Math.min(250, Math.trunc(limitPerStatus)));
  // Normal recovery is one task per claim lease. This bounded status-indexed
  // scan is only a safety net for legacy claims or a missed task enqueue.
  const offeringSnapshot = await dispatchQueueCollectionRef(firestoreDb)
    .where("status", "==", "offering").limit(boundedLimit).get();
  const summary: DispatchClaimRecoverySummary = {
    inspected: 0,
    recovered: 0,
    finalized: 0,
    released: 0,
    cancelled: 0,
    waiting: 0,
    ignored: 0,
    failed: 0,
  };

  for (const doc of offeringSnapshot.docs) {
    const rawQueue = doc.data() as QueueWithOfferData;
    if (!rawQueue?.claim) continue;
    summary.inspected++;
    try {
      const orderId = String(rawQueue.orderId ?? doc.id);
      const outcome = await recoverDispatchClaim(orderId);
      if (outcome === "wait_for_lease") {
        summary.waiting++;
      } else if (outcome === "none" || outcome === "stale") {
        summary.ignored++;
      } else if (outcome === "finalize_authoritative_assignment") {
        summary.recovered++;
        summary.finalized++;
      } else if (outcome === "release_for_redispatch") {
        summary.recovered++;
        summary.released++;
      } else if (outcome === "cancel_queue") {
        summary.recovered++;
        summary.cancelled++;
      }
    } catch (error) {
      summary.failed++;
      logger.error("RIDER_CLAIM_RECOVERY_FAILED", {recordKey: doc.id, error});
    }
  }
  return summary;
}

/** Rider decline removes only that rider; the wave advances when nobody remains. */
export async function declineDispatchOffer(uid: string, orderId: string): Promise<void> {
  await requireApprovedRider(uid);
  const ref = dispatchQueueRef(firestoreDb, orderId);
  let attempt = -1;
  let advance = false;
  let committed = false;
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as QueueWithOfferData : null;
    const declinedOffer = activeOfferForRider(current, uid);
    if (!current || current.status !== "offering" || current.claim || !declinedOffer) return;
    attempt = current.attempt;
    const remainingOffers = {...(current.activeOffers ?? {})};
    delete remainingOffers[uid];
    // Legacy sequential queues have no activeOffers map.
    const remaining = Object.entries(remainingOffers);
    advance = remaining.length === 0;
    const nextPrimary = remaining[0]?.[1];
    const nextCandidate = nextPrimary
      ? current.candidates.find((candidate) => candidate.riderId === nextPrimary.riderId)
      : undefined;
    const next: QueueWithOfferData = {
      ...current,
      currentOffer: nextPrimary ?? {...declinedOffer, expiresAt: 0},
      activeOffers: remainingOffers,
      ...(nextPrimary ? {offeredRiderId: nextPrimary.riderId} : {}),
      ...(nextCandidate ? {distanceKm: Number(nextCandidate.distanceKm.toFixed(2))} : {}),
      metrics: {
        offered: Number(current.metrics?.offered ?? 0),
        accepted: Number(current.metrics?.accepted ?? 0),
        rejected: Number(current.metrics?.rejected ?? 0) + 1,
        expired: Number(current.metrics?.expired ?? 0),
        startedAt: Number(current.metrics?.startedAt ?? current.createdAt ?? Date.now()),
      },
      updatedAt: Date.now(),
    };
    transaction.set(ref, next);
    committed = true;
  });
  if (!committed || attempt < 0) throw new DomainError("aborted", "This delivery offer is no longer available.");
  await clearRiderOfferRecords([uid], orderId);
  await stopRiderOffers([uid], orderId, "")
    .catch((error) => logger.warn("Declined rider offer removal failed", {orderId, riderId: uid, error}));
  logger.info("RIDER_OFFER_REJECTED", {orderId, riderId: uid, attempt});
  await recordRiderRewardOrderRejected(uid, orderId, Date.now())
    .catch((error) => logger.warn("Reward rejection tracking failed", {orderId, riderId: uid, error}));
  if (advance) await advanceDispatchOffer(orderId, attempt);
}

export async function recoverExhaustedDispatchesForRider(
  riderId: string,
  before: Presence | null,
  after: Presence | null,
): Promise<void> {
  // The old implementation scanned only when the rider crossed from
  // offline/stale to online/fresh. If their sole offer expired while they
  // remained online, no later heartbeat could reconsider the exhausted order.
  // Keep the instant transition scan, and add a platform-wide throttled scan
  // for normal fresh heartbeats so cooldown-expired orders cannot be stranded.
  if (!isDispatchPresenceSearchable(after)) return;
  const becameSearchable = riderBecameDispatchSearchable(before, after);
  const now = Date.now();
  const leaseRef = dispatchRecoveryScanLeaseRef(firestoreDb);
  let leaseCommitted = false;
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(leaseRef);
    const current = snapshot.exists ? snapshot.data() as {nextAt?: number} : null;
    const nextAt = Number(current?.nextAt ?? 0);
    if (!becameSearchable && nextAt > now) return;
    transaction.set(leaseRef, {
      triggeredBy: riderId,
      lastAt: now,
      nextAt: now + DISPATCH_RECOVERY_SCAN_INTERVAL_MS,
    });
    leaseCommitted = true;
  });
  if (!leaseCommitted) return;
  const snapshot = await dispatchQueueCollectionRef(firestoreDb).where("status", "==", "exhausted").limit(25).get();
  logger.info("DISPATCH_RECOVERY_SCAN", {
    riderId,
    reason: becameSearchable ? "became_searchable" : "online_retry_interval",
    exhaustedCount: snapshot.size,
  });
  for (const doc of snapshot.docs) {
    const queue = doc.data() as QueueWithOfferData;
    if (!queue?.customerId) continue;
    const orderSnapshot = await orderRef(firestoreDb, doc.id).get();
    const order = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
    if (!order || !DISPATCH_ELIGIBLE_STATUSES.has(order.status) || order.riderId) continue;
    await beginSequentialDispatch(order);
  }
}

/** Reconsider accepted orders when a rider reaches the final doorstep stage. */
export async function recoverExhaustedDispatchesForFinishingRider(riderId: string): Promise<void> {
  const snapshot = await dispatchQueueCollectionRef(firestoreDb).where("status", "==", "exhausted").limit(25).get();
  logger.info("EARLY_DISPATCH_RECOVERY_SCAN", {riderId, exhaustedCount: snapshot.size});
  for (const doc of snapshot.docs) {
    const queue = doc.data() as QueueWithOfferData;
    if (!queue?.customerId) continue;
    const orderSnapshot = await orderRef(firestoreDb, doc.id).get();
    const order = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
    if (!order || !DISPATCH_ELIGIBLE_STATUSES.has(order.status) || order.riderId) continue;
    await beginSequentialDispatch(order);
  }
}

export async function cancelDispatchOffers(orderId: string, status: "cancelled" | "expired" = "cancelled"): Promise<void> {
  const ref = dispatchQueueRef(firestoreDb, orderId);
  const snapshot = await ref.get();
  const queue = snapshot.exists ? snapshot.data() as QueueWithOfferData : null;
  const riderIds = allOfferedRiderIds(queue);
  await Promise.all([
    // `set(..., {merge: true})` instead of `update()`: an order can be
    // cancelled before any dispatch queue document was ever created for it.
    ref.set({active: false, status, updatedAt: Date.now()}, {merge: true}),
    clearRiderOfferRecords(riderIds, orderId),
    stopRiderOffers(riderIds, orderId, ""),
  ]);
  logger.info("DISPATCH_CANCELLED", {orderId, status, notifiedRiderCount: riderIds.length});
}
