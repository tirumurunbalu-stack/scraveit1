import {getFunctions} from "firebase-admin/functions";
import {logger} from "firebase-functions";
import {db, firestoreDb} from "../admin";
import {
  DISPATCH_RECOVERY_SCAN_INTERVAL_MS,
  REGION,
  ROOT,
} from "../config";
import {haversineKm, roundMoney} from "../domain/order";
import {foodRescueHolderIds} from "./foodRescueHolds";
import {fallbackPrepMinutes, partTemperature, statedPrepMinutes} from "../domain/clusterPlan";
import {
  DEFAULT_BATCH_POLICY,
  expectedReadyAt,
  planOrderBatch,
  statusEventAt,
  type BatchOrderInput,
  type BatchPlan,
  type BatchPolicy,
} from "../domain/orderBatch";
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
  compareSignalFreshness,
  findNextDispatchWave,
  isUsableBackupSignal,
  STALE_SIGNAL_MAX_AGE_MS,
  waveTimeoutSeconds,
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
import {buildRiderJobProjection, riderBatchProjection, riderOfferPayout, riderPayoutBreakdown} from "../domain/riderJob";
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
  OrderBatchLink,
  RiderCandidate,
  SavrivoOrder,
  StatusEvent,
} from "../types";
import {requireApprovedRider} from "./authz";
import {learnedPlanInputs} from "./learning";
import {notifyCustomerRiderAssigned, notifyRiderOffer, notifyRiderWake, stopRiderOffers} from "./notifications";
import {reconcileRestaurantOrderProjection} from "./orderProjection";
import {loadDispatchPolicy} from "./platformConfig";
import {refreshRiderDispatchEligibility, riderDispatchEligibilityCollectionRef} from "./riderEligibility";
import {recordRiderRewardOrderAccepted, recordRiderRewardOrderRejected} from "./riderRewards";
import {riderPublicStats} from "./riderDeliveryCount";
import {riderRegistrationRequired} from "./taxEngine";
import {isAppReviewStore, isTestStore, testDeliveryPartnerUids} from "./testAccounts";

/** Map avatars the customer and rider apps can draw. */
const RIDER_AVATARS = new Set(["bloom", "lilac", "mint", "classic", "midnight", "forest", "blue"]);

/** When the rider should reach the restaurant: from where they accepted, at town speed on roads. */
function riderPickupEta(presence: {lat?: unknown; lng?: unknown} | null | undefined,
  restaurant: {lat: number; lng: number} | undefined, at: number): {riderPickupEtaAt?: number} {
  const lat = Number(presence?.lat);
  const lng = Number(presence?.lng);
  if (!restaurant || !Number.isFinite(lat) || !Number.isFinite(lng) ||
    !Number.isFinite(Number(restaurant.lat)) || !Number.isFinite(Number(restaurant.lng))) return {};
  const roadMetres = haversineKm({lat, lng}, restaurant) * 1000 * 1.3;
  const minutes = Math.min(60, Math.max(1, Math.ceil(roadMetres / 300) + 1));
  return {riderPickupEtaAt: at + minutes * 60_000};
}

/** When the rider reaches `to` after collecting at `via` first (pickup takes about 3 minutes). */
function viaPickupEta(presence: {lat?: unknown; lng?: unknown} | null | undefined,
  via: {lat: number; lng: number} | undefined, to: {lat: number; lng: number} | undefined, at: number): {riderPickupEtaAt?: number} {
  const first = riderPickupEta(presence, via, at).riderPickupEtaAt;
  const second = via ? riderPickupEta(via, to, 0).riderPickupEtaAt : undefined;
  return first && second ? {riderPickupEtaAt: first + 3 * 60_000 + second} : {};
}

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
  riderId?: string;
  orderId?: string;
  restaurantLat?: number;
  restaurantLng?: number;
  trip?: unknown;
  batch?: unknown;
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
  payoutBreakdown?: {tripPay: number; feeKm?: number; incentives: number; tip: number; total: number};
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
      riderName: String(after.riderName ?? "Scraveit Partner").slice(0, 120),
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

const RIDER_WAKE_LIMIT = 10;

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
  previousBackupRiders: ReadonlySet<string> = new Set(),
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
  // Test orders (test customer, or a test store) go only to test delivery partners, and real orders never to them.
  const [testStore, testPartners, rescueHolders] = await Promise.all([
    isTestStore(order.restaurantId),
    testDeliveryPartnerUids(),
    // Waiting with Food Rescue food (services/foodRescue.ts): no new orders until it ends.
    foodRescueHolderIds().catch((error) => {
      logger.warn("FOOD_RESCUE_HOLDERS_READ_FAILED", {orderId: order.id, error: String(error)});
      return new Set<string>();
    }),
  ]);
  const testSide = testStore || order.testOrder === true;
  const eligibilityByRider: Record<string, RiderDispatchEligibilityProjection> = {};
  const now = Date.now();
  const rejected = {offline: 0, stale: 0, location: 0, accuracy: 0, distance: 0, busy: 0, cooldown: 0, test: 0};
  let backupSignalCount = 0;
  let eligibilityProjectionHits = 0;
  let eligibilityProjectionFallbacks = 0;
  let eligibilityProjectionMissing = 0;
  let eligibilityProjectionStale = 0;
  const nearestPresence = Object.entries(presences).flatMap(([riderId, presence]) => {
    const lat = Number(presence?.lat);
    const lng = Number(presence?.lng);
    if (testPartners.has(riderId) !== testSide) { rejected.test++; return []; }
    if (presence?.online !== true) { rejected.offline++; return []; }
    if (rescueHolders.has(riderId)) { rejected.busy++; return []; }
    // An Online rider stays Online until they toggle off, even when their phone has stopped
    // reporting. They rank after every live rider, at their last known position.
    const signalAgeMs = now - Number(presence.updatedAt ?? 0);
    const staleSignal = signalAgeMs > policy.presenceFreshMs;
    if (staleSignal && !isUsableBackupSignal(signalAgeMs)) { rejected.stale++; return []; }
    if (!isValidDispatchCoordinate(lat, lng)) { rejected.location++; return []; }
    // Workload is verified from the authoritative riderJobs projection below.
    // A presence activeOrderId alone must not delay the next offer when that
    // delivery has already reached the customer's doorstep.
    if (!isDispatchPresenceEligible({...presence, activeOrderId: undefined}, now, {
      presenceFreshMs: staleSignal ? signalAgeMs : policy.presenceFreshMs,
      maxLocationAccuracyMeters: policy.maxLocationAccuracyMeters,
    })) { rejected.accuracy++; return []; }
    // A rider who missed a backup ring and is now back on the app gets the order straight away.
    const backOnline = !staleSignal && previousBackupRiders.has(riderId);
    if (!backOnline && wasRecentlyOffered(attemptedRiders[riderId], now, policy.reofferCooldownMs)) { rejected.cooldown++; return []; }
    const distanceKm = haversineKm({lat, lng}, order.restaurantLocation);
    if (!Number.isFinite(distanceKm) || distanceKm > policy.maxRadiusKm) {
      rejected.distance++;
      return [];
    }
    return [{riderId, presence, distanceKm, staleSignal}];
  }).sort((a, b) => compareSignalFreshness(a, b) || a.distanceKm - b.distanceKm).slice(0, 100);
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
  const hydrated = await Promise.all(nearestPresence.map(async ({riderId, presence, distanceKm, staleSignal}) => {
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
      riderName: String(eligibility.riderName || presence.riderName || "Scraveit Partner"),
      distanceKm,
      activeLoad: eligibility.activeLoad,
      ...(staleSignal ? {staleSignal: true} : {}),
    };
  }));
  const ranked = hydrated.filter((entry): entry is Omit<RiderCandidate, "score"> => entry !== null)
    .map((candidate): RiderCandidate => ({
      ...candidate,
      score: roundMoney(candidate.distanceKm + candidate.activeLoad * policy.fairnessLoadPenaltyKm),
    }))
    .sort((a, b) => compareSignalFreshness(a, b) || a.score - b.score || a.distanceKm - b.distanceKm || a.riderId.localeCompare(b.riderId))
    .slice(0, policy.maxCandidates);
  backupSignalCount = ranked.filter((candidate) => candidate.staleSignal === true).length;
  logger.info("RIDER_CANDIDATES_RANKED", {
    orderId: order.id,
    restaurantId: order.restaurantId,
    cityKey,
    indexedPresenceCount: Object.keys(presences).length,
    eligibleCount: ranked.length,
    backupSignalCount,
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

/**
 * Founder's rule (10 Nov 2026): an order is placed only when a delivery partner
 * is free near the restaurant right now, like Zomato and Swiggy. "Free" uses the
 * same checks as a real offer (online, fresh and accurate location, approved,
 * under the cash limit, not on another delivery) inside the live dispatch radius.
 * A store that delivers itself skips it, and a failed read never blocks an order.
 */
export const DELIVERY_PARTNERS_BUSY_MESSAGE = (restaurantName: string): string =>
  `All delivery partners near ${restaurantName || "this restaurant"} are busy right now. Please try again in a few minutes.`;

type DeliveryPartnerCheckRestaurant = Pick<CatalogRestaurant, "id" | "name" | "lat" | "lng"> & {selfDelivery?: unknown};

/** Free delivery partners near the store right now; null when it cannot be told (never treated as busy). */
async function freeDeliveryPartnersNear(restaurant: DeliveryPartnerCheckRestaurant, testOrder = false): Promise<{free: number; radiusKm: number} | null> {
  if (restaurant.selfDelivery === true) return null;
  // App-review stores (Scraveit Review Restaurant/Grocery/Dairy): a reviewer's test order is never told
  // "delivery partners busy", so the reviewer can finish an order wherever they are.
  if (testOrder && await isAppReviewStore(restaurant.id)) return null;
  const lat = Number(restaurant.lat);
  const lng = Number(restaurant.lng);
  if (!isValidDispatchCoordinate(lat, lng)) return null;
  try {
    const policy = await loadDispatchPolicy();
    const probe = {id: `partner-check:${restaurant.id}`, restaurantId: restaurant.id, restaurantLocation: {lat, lng}, ...(testOrder ? {testOrder: true} : {})};
    const free = (await candidatesFor(probe as unknown as SavrivoOrder, policy)).length;
    return {free, radiusKm: policy.maxRadiusKm};
  } catch (error) {
    logger.warn("DELIVERY_PARTNER_CHECK_FAILED", {restaurantId: restaurant.id, error});
    return null;
  }
}

export async function assertDeliveryPartnerFreeNear(restaurant: DeliveryPartnerCheckRestaurant, testOrder = false): Promise<void> {
  const found = await freeDeliveryPartnersNear(restaurant, testOrder);
  if (!found || found.free > 0) return;
  logger.info("ORDER_BLOCKED_DELIVERY_PARTNERS_BUSY", {restaurantId: restaurant.id, radiusKm: found.radiusKm});
  throw new DomainError("failed-precondition", DELIVERY_PARTNERS_BUSY_MESSAGE(restaurant.name));
}

/**
 * The same answer for the customer app before any order exists, so the
 * restaurant page can say it as soon as it opens. Same check as Place order.
 */
export async function deliveryPartnerStatusForRestaurant(restaurantId: string, testOrder = false): Promise<{busy: boolean; message: string}> {
  try {
    const snapshot = await restaurantRef(firestoreDb, restaurantId).get();
    if (!snapshot.exists) return {busy: false, message: ""};
    const restaurant = {...(snapshot.data() as CatalogRestaurant), id: restaurantId};
    const found = await freeDeliveryPartnersNear(restaurant, testOrder);
    if (!found || found.free > 0) return {busy: false, message: ""};
    return {busy: true, message: DELIVERY_PARTNERS_BUSY_MESSAGE(restaurant.name)};
  } catch (error) {
    logger.warn("DELIVERY_PARTNER_CHECK_FAILED", {restaurantId, error});
    return {busy: false, message: ""};
  }
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

function queueWaveTimeoutSeconds(queue: QueueWithOfferData, policy: DispatchPolicy): number {
  const offeredIds = new Set(activeOfferEntries(queue).map(([riderId]) => riderId));
  return waveTimeoutSeconds(queue.candidates.filter((candidate) => offeredIds.has(candidate.riderId)), policy.offerTimeoutSeconds);
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
    // Multi-restaurant trips: the first pickup says how many restaurants the trip has; a later
    // pickup is offered to that same rider while they are on it.
    ...(queue.tripPickups ? {tripPickups: queue.tripPickups} : {}),
    ...(queue.bundle ? {bundle: {leadOrderId: queue.bundle.leadOrderId, stop: queue.bundle.stop, stops: queue.bundle.stops,
      ...(queue.bundle.kind === "batch" ? {kind: "batch", pickupOrder: queue.bundle.pickupOrder ?? [],
        dropOrder: queue.bundle.dropOrder ?? [], leadExtraMinutes: queue.bundle.leadExtraMinutes ?? 0} : {})}} : {}),
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

export type BundleDecision =
  | {kind: "normal"}
  | {kind: "wait"}
  | {kind: "offer"; candidate: RiderCandidate; bundle: NonNullable<DispatchQueueRecord["bundle"]>};

const RIDING_STATUSES = new Set(["Out for delivery", "Near you", "Arrived", "Delivered", "Cancelled"]);

/**
 * Multi-restaurant trips (services/clusterOrders): the first pickup is dispatched as usual; each
 * later pickup waits for that rider and is then offered to them alone. It goes to any rider when
 * the first pickup is cancelled, its rider has already left for the customer, the trip's rider
 * did not take it, or this kitchen's food is ready while the first pickup still has no rider.
 */
async function bundleDecision(order: SavrivoOrder, previous: QueueWithOfferData | null): Promise<BundleDecision> {
  const trip = order.clusterTrip;
  if (!trip || trip.leadOrderId === order.id || trip.orderIds.length < 2) return {kind: "normal"};
  if (previous?.bundle || previous?.bundleTried) return {kind: "normal"};
  const leadSnapshot = await orderRef(firestoreDb, trip.leadOrderId).get();
  return planBundle(order, previous, leadSnapshot.exists ? leadSnapshot.data() as SavrivoOrder : null);
}

/** The decision itself, given the trip's first pickup as it is now. */
export function planBundle(order: SavrivoOrder, previous: Pick<QueueWithOfferData, "bundle" | "bundleTried"> | null, lead: SavrivoOrder | null): BundleDecision {
  const trip = order.clusterTrip;
  if (!trip || trip.leadOrderId === order.id || trip.orderIds.length < 2) return {kind: "normal"};
  if (previous?.bundle || previous?.bundleTried) return {kind: "normal"};
  if (!lead || lead.id !== trip.leadOrderId || RIDING_STATUSES.has(lead.status)) return {kind: "normal"};
  if (!lead.riderId) return order.status === "Ready for pickup" ? {kind: "normal"} : {kind: "wait"};
  const from = lead.restaurantLocation, to = order.restaurantLocation;
  const distanceKm = from && to ? haversineKm(from, to) : 0;
  return {
    kind: "offer",
    candidate: {riderId: lead.riderId, riderName: String(lead.riderName ?? "Scraveit Partner"),
      distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0, activeLoad: 1, score: 0},
    bundle: {leadOrderId: lead.id, riderId: lead.riderId, stop: trip.stop, stops: trip.orderIds.length},
  };
}

/**
 * A rider on a trip may take that trip's later pickups even though they already carry an order.
 * A second customer's order (a batch) joins only while the rider still has just that one order and
 * has not yet left its restaurant.
 */
export function bundleClaimAllowed(queue: Pick<QueueWithOfferData, "bundle"> | null, uid: string,
  jobs: Record<string, {status?: string; orderStatus?: string}>): boolean {
  const bundle = queue?.bundle;
  if (!bundle || bundle.riderId !== uid) return false;
  const lead = jobs[`${uid}_${bundle.leadOrderId}`];
  if (!lead || lead.status !== "active") return false;
  if (bundle.kind !== "batch") return true;
  const activeJobs = Object.values(jobs).filter((job) => job?.status === "active").length;
  return activeJobs === 1 && BATCH_LEAD_JOB_STATUSES.has(String(lead.orderStatus ?? ""));
}

/** The rider-facing statuses of an order a second customer's order can still join. */
const BATCH_LEAD_JOB_STATUSES = new Set(["Assigned", "Handed to rider"]);
/** Canonical statuses of the rider's order while a batch can still be formed. */
const BATCH_LEAD_ORDER_STATUSES = new Set(["Accepted", "Preparing", "Ready for pickup", "Assigned", "Handed to rider"]);
/** How long a mid-trip rider has to answer an added order: the plan is only good for a short while. */
const BATCH_OFFER_SECONDS = 120;
/** Riders nearest the restaurant whose current trip is checked for a batch. */
const BATCH_RIDERS_CHECKED = 5;

function orderItemCount(order: Pick<SavrivoOrder, "items">): number {
  return (order.items ?? []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

/** Never batched: multi-restaurant parts (timed to arrive together), scheduled and already batched orders. */
function batchLocked(order: SavrivoOrder): boolean {
  return Boolean(order.clusterTrip || order.clusterId || order.batch || order.deliveryMode === "scheduled");
}

/** What the batch planner needs to know about one order, now. */
export function batchOrderInput(order: SavrivoOrder, prepMinutes: number, now: number): BatchOrderInput {
  const handedAt = order.status === "Handed to rider" ? statusEventAt(order, "Handed to rider") ?? now : null;
  return {
    id: order.id,
    createdAt: Number(order.createdAt),
    status: order.status,
    restaurant: {lat: Number(order.restaurantLocation?.lat), lng: Number(order.restaurantLocation?.lng)},
    drop: {lat: Number(order.address?.lat), lng: Number(order.address?.lng)},
    readyAt: expectedReadyAt(order, prepMinutes, now),
    ...(handedAt !== null ? {pickedUpAt: handedAt} : {}),
    promiseAt: Number(order.createdAt) + Math.max(10, Number(order.etaMax) || 45) * 60_000,
    temperature: partTemperature((order.items ?? []).map((item) => String(item.name ?? ""))),
    itemCount: orderItemCount(order),
    locked: batchLocked(order),
  };
}

/** Riders who carry exactly one order, still before its restaurant, picked up within reach of `point`. */
export function batchLeadsNear(jobs: ReadonlyArray<RiderJob>, point: {lat: number; lng: number}, maxKm: number,
  limit = BATCH_RIDERS_CHECKED): Array<{riderId: string; leadOrderId: string; restaurantKm: number}> {
  const byRider = new Map<string, RiderJob[]>();
  for (const job of jobs) {
    const riderId = String(job.riderId ?? "");
    if (!riderId || job.status !== "active") continue;
    byRider.set(riderId, [...(byRider.get(riderId) ?? []), job]);
  }
  return [...byRider].flatMap(([riderId, riderJobs]) => {
    const job = riderJobs[0];
    if (riderJobs.length !== 1 || !job || job.trip || job.batch || !job.orderId) return [];
    if (!BATCH_LEAD_JOB_STATUSES.has(String(job.orderStatus ?? ""))) return [];
    const restaurantKm = haversineKm({lat: Number(job.restaurantLat), lng: Number(job.restaurantLng)}, point);
    if (!Number.isFinite(restaurantKm) || restaurantKm > maxKm) return [];
    return [{riderId, leadOrderId: String(job.orderId), restaurantKm}];
  }).sort((a, b) => a.restaurantKm - b.restaurantKm || a.riderId.localeCompare(b.riderId)).slice(0, limit);
}

/**
 * Two-order batching (domain/orderBatch): a new order is first offered to a rider who is on the way
 * to a nearby restaurant with one order whose customer lives near this one, when the plan keeps both
 * customers' delivery times. Otherwise the order is dispatched as usual.
 */
async function batchDecision(order: SavrivoOrder, previous: QueueWithOfferData | null): Promise<BundleDecision> {
  if (batchLocked(order) || previous?.bundle || previous?.bundleTried) return {kind: "normal"};
  try {
    const policy = await loadDispatchPolicy();
    if (policy.batchingEnabled === false) return {kind: "normal"};
    return await findBatch(order, policy);
  } catch (error) {
    logger.warn("BATCH_PLAN_FAILED", {orderId: order.id, error: String(error)});
    return {kind: "normal"};
  }
}

async function findBatch(order: SavrivoOrder, policy: DispatchPolicy): Promise<BundleDecision> {
  const point = order.restaurantLocation;
  if (!point || !isValidDispatchCoordinate(Number(point.lat), Number(point.lng))) return {kind: "normal"};
  const activeJobs = await riderJobsCollectionRef(firestoreDb).where("status", "==", "active").limit(500).get();
  const leads = batchLeadsNear(activeJobs.docs.map((doc) => doc.data() as RiderJob), point, DEFAULT_BATCH_POLICY.maxRestaurantGapKm);
  if (!leads.length) return {kind: "normal"};
  const now = Date.now();
  const restaurantSnapshot = await restaurantRef(firestoreDb, order.restaurantId).get();
  const restaurant = restaurantSnapshot.exists ? restaurantSnapshot.data() as CatalogRestaurant : null;
  const learned = await learnedPlanInputs(availabilityCityKey(restaurant?.city), now)
    .catch(() => ({prepFor: null, minutesPerKm: null}));
  const restaurants = new Map<string, CatalogRestaurant | null>([[order.restaurantId, restaurant]]);
  const prepFor = async (target: SavrivoOrder): Promise<number> => {
    if (!restaurants.has(target.restaurantId)) {
      const snapshot = await restaurantRef(firestoreDb, target.restaurantId).get();
      restaurants.set(target.restaurantId, snapshot.exists ? snapshot.data() as CatalogRestaurant : null);
    }
    const place = restaurants.get(target.restaurantId);
    return learned.prepFor ?
      learned.prepFor(target.restaurantId, orderItemCount(target), statedPrepMinutes(place)) :
      fallbackPrepMinutes(place);
  };
  const batchPolicy: BatchPolicy = learned.minutesPerKm ?
    {...DEFAULT_BATCH_POLICY, minutesPerStraightKm: learned.minutesPerKm} : DEFAULT_BATCH_POLICY;
  const next = batchOrderInput(order, await prepFor(order), now);
  const outcomes: Array<{riderId: string; reason: string}> = [];
  const plans: Array<{riderId: string; riderName: string; riderKm: number; lead: SavrivoOrder; plan: BatchPlan}> = [];
  // A test order joins only a test delivery partner's trip, and a real order never does.
  const [testStore, testPartners] = await Promise.all([isTestStore(order.restaurantId), testDeliveryPartnerUids()]);
  const testSide = testStore || order.testOrder === true;
  for (const {riderId, leadOrderId} of leads) {
    if (testPartners.has(riderId) !== testSide) { outcomes.push({riderId, reason: "test_account_split"}); continue; }
    const [presenceSnapshot, jobsSnapshot, leadSnapshot, eligibilitySnapshot] = await Promise.all([
      db.ref(`${ROOT}/riderPresence/${riderId}`).get(),
      riderJobsCollectionRef(firestoreDb).where("riderId", "==", riderId).get(),
      orderRef(firestoreDb, leadOrderId).get(),
      riderDispatchEligibilityCollectionRef(firestoreDb).doc(riderId).get(),
    ]);
    const presence = presenceSnapshot.val() as Presence | null;
    const lat = Number(presence?.lat), lng = Number(presence?.lng);
    if (presence?.online !== true || now - Number(presence.updatedAt ?? 0) > policy.presenceFreshMs ||
      !isValidDispatchCoordinate(lat, lng)) { outcomes.push({riderId, reason: "rider_offline"}); continue; }
    const eligibility = eligibilitySnapshot.exists ? eligibilitySnapshot.data() as RiderDispatchEligibilityProjection : null;
    if (eligibility && (eligibility.approved === false || eligibility.codBlocked || eligibility.orderBlocked)) {
      outcomes.push({riderId, reason: "rider_on_hold"}); continue;
    }
    const riderJobs = jobsSnapshot.docs.map((doc) => doc.data() as RiderJob).filter((job) => job.status === "active");
    if (riderJobs.length !== 1 || riderJobs[0]?.orderId !== leadOrderId) { outcomes.push({riderId, reason: "rider_busy"}); continue; }
    const lead = leadSnapshot.exists ? leadSnapshot.data() as SavrivoOrder : null;
    if (!lead || lead.riderId !== riderId || !BATCH_LEAD_ORDER_STATUSES.has(lead.status)) {
      outcomes.push({riderId, reason: "lead_moved_on"}); continue;
    }
    const plan = planOrderBatch(batchOrderInput(lead, await prepFor(lead), now), next, {lat, lng}, now, batchPolicy);
    if (!plan.ok) { outcomes.push({riderId, reason: plan.reason}); continue; }
    plans.push({riderId, riderName: String(lead.riderName ?? presence.riderName ?? "Scraveit Partner"),
      riderKm: haversineKm({lat, lng}, point), lead, plan});
  }
  // The rider whose first customer is delayed least; then the one nearest this restaurant.
  const best = plans.sort((a, b) => a.plan.leadExtraMinutes - b.plan.leadExtraMinutes || a.riderKm - b.riderKm)[0];
  logger.info(best ? "BATCH_PLANNED" : "BATCH_NOT_FOUND", {
    orderId: order.id,
    checked: leads.length,
    rejected: outcomes,
    ...(best ? {riderId: best.riderId, leadOrderId: best.lead.id, pickupOrder: best.plan.pickupOrder,
      dropOrder: best.plan.dropOrder, leadExtraMinutes: best.plan.leadExtraMinutes, slackMinutes: best.plan.slackMinutes,
      restaurantGapKm: best.plan.restaurantGapKm, dropGapKm: best.plan.dropGapKm, learnedTravel: Boolean(learned.minutesPerKm),
      learnedPrep: Boolean(learned.prepFor)} : {}),
  });
  if (!best) return {kind: "normal"};
  return {
    kind: "offer",
    candidate: {riderId: best.riderId, riderName: best.riderName,
      distanceKm: Number.isFinite(best.riderKm) ? best.riderKm : 0, activeLoad: 1, score: 0},
    bundle: {kind: "batch", leadOrderId: best.lead.id, riderId: best.riderId, stop: 1, stops: 2,
      pickupOrder: [...best.plan.pickupOrder], dropOrder: [...best.plan.dropOrder], leadExtraMinutes: best.plan.leadExtraMinutes},
  };
}

/** Dispatches a trip's later pickups once its first pickup has a rider (or is cancelled). */
export async function releaseTripFollowers(lead: SavrivoOrder): Promise<void> {
  const trip = lead.clusterTrip;
  if (!trip || trip.leadOrderId !== lead.id) return;
  for (const followerId of trip.orderIds.filter((id) => id !== lead.id)) {
    const [orderSnapshot, queueSnapshot] = await Promise.all([
      orderRef(firestoreDb, followerId).get(),
      dispatchQueueRef(firestoreDb, followerId).get(),
    ]);
    const follower = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
    if (!follower || follower.riderId || !DISPATCH_ELIGIBLE_STATUSES.has(follower.status)) continue;
    const queue = queueSnapshot.exists ? queueSnapshot.data() as QueueWithOfferData : null;
    if (queue && ["offering", "assigned"].includes(queue.status)) continue;
    await beginSequentialDispatch(follower);
  }
}

/** The two orders' shared link, as written on the added order. */
export function batchLinkFrom(bundle: NonNullable<DispatchQueueRecord["bundle"]>, next: SavrivoOrder, lead: SavrivoOrder,
  at: number): OrderBatchLink {
  const placed = [lead, next].sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || a.id.localeCompare(b.id)).map((entry) => entry.id);
  const pickupOrder = bundle.pickupOrder?.length === 2 && placed.every((id) => bundle.pickupOrder!.includes(id)) ?
    [...bundle.pickupOrder] : [lead.id, next.id];
  // Doors always go in the order the customers placed them.
  return {
    id: `bt_${lead.id}_${next.id}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 200),
    orderIds: placed,
    leadOrderId: lead.id,
    pickupOrder,
    dropOrder: placed,
    position: placed.indexOf(next.id) + 1,
    size: 2,
    leadExtraMinutes: Number(bundle.leadExtraMinutes ?? 0),
    createdAt: at,
  };
}

/** The same link as seen from one of its orders. */
export function batchLinkFor(link: OrderBatchLink, orderId: string): OrderBatchLink {
  return {...link, position: link.dropOrder.indexOf(orderId) + 1};
}

export async function beginSequentialDispatch(order: SavrivoOrder): Promise<QueueWithOfferData | null> {
  // A self-delivering store takes its own orders (assignStoreAsRider); no rider is ever offered one.
  if (!DISPATCH_ELIGIBLE_STATUSES.has(order.status) || order.riderId || order.selfDelivery === true) return null;
  const ref = dispatchQueueRef(firestoreDb, order.id);
  const previousSnapshot = await ref.get();
  const previous = previousSnapshot.exists ? previousSnapshot.data() as QueueWithOfferData : null;
  const priorAttempts = previous?.attemptedRiders ?? {};
  // A later pickup of a shared multi-restaurant trip goes to the rider who took the first one;
  // any other order is first offered to a rider already heading nearby, when both customers stay on time.
  const bundle = order.clusterTrip ? await bundleDecision(order, previous) : await batchDecision(order, previous);
  if (bundle.kind === "wait") {
    logger.info("BUNDLE_WAITING_FOR_LEAD", {orderId: order.id, leadOrderId: order.clusterTrip?.leadOrderId});
    return null;
  }
  const basePolicy = previous?.policySnapshot && !previous.bundle ? policyForQueue(previous) : await loadDispatchPolicy();
  // The trip's rider is mid-trip: give them longer to answer, and only them. An added order's plan
  // holds only briefly, so that offer is short.
  const policy: DispatchPolicy = bundle.kind === "offer" ?
    {...basePolicy, ridersPerWave: 1, offerTimeoutSeconds: bundle.bundle.kind === "batch" ?
      BATCH_OFFER_SECONDS : Math.max(basePolicy.offerTimeoutSeconds, 300)} : basePolicy;
  const previousBackupRiders = new Set(previous?.backupRiders ?? []);
  const candidates = bundle.kind === "offer" ? [bundle.candidate] : await candidatesFor(order, policy, priorAttempts, previousBackupRiders);
  const now = Date.now();
  // candidatesFor has already dropped riders still in their cooldown, so a rider it returned may be
  // asked again after missing an earlier offer. A rider who said no isn't asked again for this order.
  const declinedRiders = previous?.declinedRiders ?? {};
  const askableAgain = new Set(candidates.map((candidate) => candidate.riderId)
    .filter((riderId) => !Object.prototype.hasOwnProperty.call(declinedRiders, riderId)));
  const standingAttempts = bundle.kind === "offer" ? priorAttempts :
    Object.fromEntries(Object.entries(priorAttempts).filter(([riderId]) => !askableAgain.has(riderId)));
  // The trip's rider is asked even if an earlier offer of this order reached them before.
  const wave = findNextDispatchWave(candidates, bundle.kind === "offer" ? {} : standingAttempts, policy, 0);
  const trip = order.clusterTrip;
  const tripPickups = trip && trip.leadOrderId === order.id && trip.orderIds.length > 1 ? trip.orderIds.length : 0;
  const selected = wave?.candidates ?? [];
  const activeOffers = offersForWave(
    selected,
    wave?.wave ?? 0,
    now,
    waveTimeoutSeconds(selected, policy.offerTimeoutSeconds),
  );
  const first = selected[0];
  const attempt = previous ? Number(previous.attempt ?? -1) + 1 : 0;
  const attemptedRiders = {...standingAttempts};
  selected.forEach((candidate) => { attemptedRiders[candidate.riderId] = now; });
  // Asked on a live signal, a rider is an ordinary candidate again and the usual wait applies.
  const backupRiders = new Set(previousBackupRiders);
  candidates.forEach((candidate) => { if (candidate.staleSignal === true) backupRiders.add(candidate.riderId); });
  selected.forEach((candidate) => { if (candidate.staleSignal !== true) backupRiders.delete(candidate.riderId); });
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
    ...(previous?.declinedRiders ? {declinedRiders: previous.declinedRiders} : {}),
    ...(backupRiders.size ? {backupRiders: [...backupRiders]} : {}),
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
    ...(bundle.kind === "offer" ? {bundle: bundle.bundle} : {}),
    ...(tripPickups ? {tripPickups} : {}),
    ...(previous?.bundle || previous?.bundleTried ? {bundleTried: true} : {}),
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
    await scheduleTimeout(order.id, activeQueue.attempt, queueWaveTimeoutSeconds(activeQueue, activePolicy));
    if (committed) {
      // Online riders whose phones went quiet: their Rider app starts itself again, if it can.
      const quietRiders = activeQueue.candidates.filter((candidate) => candidate.staleSignal === true)
        .slice(0, RIDER_WAKE_LIMIT).map((candidate) => candidate.riderId);
      await Promise.all(quietRiders.map((riderId) => notifyRiderWake(riderId)
        .catch((error) => logger.warn("Rider wake push failed", {orderId: order.id, riderId, error}))));
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
        waveTimeoutSeconds(nextWave.candidates, policy.offerTimeoutSeconds),
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
  if (queue.status === "exhausted" && queue.bundle) {
    // The trip's rider did not take this pickup: any nearby rider can now.
    const snapshot = await orderRef(firestoreDb, orderId).get();
    const pending = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
    logger.info("BUNDLE_OFFER_NOT_TAKEN", {orderId, riderId: queue.bundle.riderId});
    if (pending && DISPATCH_ELIGIBLE_STATUSES.has(pending.status) && !pending.riderId) await beginSequentialDispatch(pending);
    return;
  }
  if (queue.status !== "offering" || !nextRiderIds.length) return;
  const orderSnapshot = await orderRef(firestoreDb, orderId).get();
  const order = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
  if (!order || !DISPATCH_ELIGIBLE_STATUSES.has(order.status) || order.riderId) {
    await ref.update({status: "cancelled", active: false, updatedAt: Date.now()});
    return;
  }
  const policy = policyForQueue(queue);
  await scheduleTimeout(orderId, nextAttempt, queueWaveTimeoutSeconds(queue, policy));
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
    throw new DomainError("failed-precondition", "Resolve the account hold before accepting another order.");
  }
  // A rider we rang as a backup answers from a closed app: their signal is old by design.
  const offeredAsBackup = cachedQueue?.candidates?.some((candidate) =>
    candidate.riderId === uid && candidate.staleSignal === true) === true;
  if (!presence || !isDispatchPresenceEligible({...presence, activeOrderId: undefined}, Date.now(), {
    presenceFreshMs: offeredAsBackup ? STALE_SIGNAL_MAX_AGE_MS : policy.presenceFreshMs,
    maxLocationAccuracyMeters: policy.maxLocationAccuracyMeters,
  })) {
    throw new DomainError("failed-precondition", "Go online with current location before accepting an order.");
  }
  if (!Number.isFinite(Number(presence.lat)) || !Number.isFinite(Number(presence.lng))) {
    throw new DomainError("failed-precondition", "Your current location is required to accept this order.");
  }
  if (!isEarlyDispatchWorkloadEligible(jobs) && !bundleClaimAllowed(cachedQueue, uid, jobs)) {
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
  // An added order (batch): the rider's first order is linked in the same transaction, so the rider
  // can never be handed a third order, and the plan is dropped if that order has moved on.
  const batchBundle = queue.bundle?.kind === "batch" && queue.bundle.riderId === uid ? queue.bundle : null;
  const leadDocRef = batchBundle ? orderRef(firestoreDb, batchBundle.leadOrderId) : null;
  let batchStale = false;
  let batchPickupEta: {riderPickupEtaAt?: number} = {};
  const order = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    batchStale = false;
    batchPickupEta = {};
    const snapshot = await transaction.get(orderDocRef);
    const leadSnapshot = leadDocRef ? await transaction.get(leadDocRef) : null;
    const orderValue = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
    if (!orderValue || orderValue.id !== before.id || orderValue.customerId !== before.customerId ||
      orderValue.restaurantId !== before.restaurantId || orderValue.createdAt !== before.createdAt ||
      !DISPATCH_ELIGIBLE_STATUSES.has(orderValue.status) || orderValue.riderId) return orderValue;
    let batch: OrderBatchLink | null = null;
    if (batchBundle && leadDocRef) {
      const lead = leadSnapshot?.exists ? leadSnapshot.data() as SavrivoOrder : null;
      if (!lead || lead.riderId !== uid || lead.batch || lead.clusterTrip || !BATCH_LEAD_ORDER_STATUSES.has(lead.status)) {
        batchStale = true;
        return orderValue;
      }
      batch = batchLinkFrom(batchBundle, orderValue, lead, claimAt);
      const leadFirst = batch.pickupOrder[0] === lead.id;
      batchPickupEta = leadFirst && lead.status !== "Handed to rider" ?
        viaPickupEta(presence, lead.restaurantLocation, orderValue.restaurantLocation, claimAt) : {};
      // The rider now visits this order's kitchen first: the first restaurant sees them later.
      const leadEta = leadFirst ? {} : viaPickupEta(presence, orderValue.restaurantLocation, lead.restaurantLocation, claimAt);
      transaction.update(leadDocRef, {
        batch: batchLinkFor(batch, lead.id),
        ...(leadEta.riderPickupEtaAt ? {riderPickupEtaAt: Math.max(Number(lead.riderPickupEtaAt ?? 0), leadEta.riderPickupEtaAt)} : {}),
        updatedAt: claimAt,
      });
    }
    const ready = orderValue.status === "Ready for pickup";
    const candidate: SavrivoOrder = {
      ...stripPrivateOrderFields(orderValue),
      riderId: uid,
      riderName: String(rider.fullName ?? presence.riderName ?? "Scraveit Partner"),
      ...(rider.phone ? {riderPhone: String(rider.phone).slice(0, 30)} : {}),
      // The avatar customers see riding on the live map (a fixed preset id).
      ...(RIDER_AVATARS.has(String(rider.avatar ?? "")) ? {riderAvatar: String(rider.avatar)} : {}),
      // When the restaurant can expect the rider, shown on the restaurant's order card.
      ...riderPickupEta(presence, orderValue.restaurantLocation, claimAt),
      ...batchPickupEta,
      ...riderPublicStats(rider),
      riderAssignedAt: claimAt,
      ...(restaurant?.phone ? {restaurantPhone: String(restaurant.phone).slice(0, 30)} : {}),
      ...(batch ? {batch: batchLinkFor(batch, orderValue.id)} : {}),
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
  if (batchStale) {
    // The rider's first order left its restaurant (or changed) since the offer: offer this one normally.
    await releaseQueueClaim(queueRef, uid);
    logger.info("BATCH_CLAIM_STALE", {orderId, riderId: uid, leadOrderId: batchBundle?.leadOrderId});
    await declineDispatchOffer(uid, orderId)
      .catch((error) => logger.warn("BATCH_STALE_REDISPATCH_FAILED", {orderId, riderId: uid, error: String(error)}));
    throw new DomainError("failed-precondition", "This extra order no longer fits your trip.");
  }
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
    throw new DomainError("aborted", "This order is no longer available. Another delivery partner secured it.");
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
    // Who may post live location for this order (checked by the RTDB rules).
    db.ref(`${ROOT}/trackingAssignments/${order.id}`).set({riderId: uid, customerId: order.customerId, assignedAt: claimAt}),
  ]);
  // The rider's first order learns it now shares the trip (its job is rebuilt only on status changes).
  if (order.batch && order.batch.leadOrderId !== order.id) {
    await riderJobRef(firestoreDb, uid, order.batch.leadOrderId)
      .set({batch: riderBatchProjection(batchLinkFor(order.batch, order.batch.leadOrderId)), updatedAt: claimAt}, {merge: true})
      .catch((error) => logger.warn("BATCH_LEAD_JOB_UPDATE_FAILED", {orderId: order.id, riderId: uid, error: String(error)}));
  }
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
  // First pickup of a shared trip taken: offer the trip's other pickups to this rider.
  if (order.clusterTrip?.leadOrderId === order.id) {
    await releaseTripFollowers(order)
      .catch((error) => logger.warn("BUNDLE_FOLLOWER_DISPATCH_FAILED", {orderId: order.id, riderId: uid, error: String(error)}));
  }
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
  let extraPickup = false;
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as QueueWithOfferData : null;
    const declinedOffer = activeOfferForRider(current, uid);
    if (!current || current.status !== "offering" || current.claim || !declinedOffer) return;
    attempt = current.attempt;
    extraPickup = Boolean(current.bundle);
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
      declinedRiders: {...(current.declinedRiders ?? {}), [uid]: Date.now()},
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
  logger.info("RIDER_OFFER_REJECTED", {orderId, riderId: uid, attempt, extraPickup});
  // Saying no to an extra pickup mid-trip never counts against a rider's acceptance rate.
  if (!extraPickup) {
    await recordRiderRewardOrderRejected(uid, orderId, Date.now())
      .catch((error) => logger.warn("Reward rejection tracking failed", {orderId, riderId: uid, error}));
  }
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
