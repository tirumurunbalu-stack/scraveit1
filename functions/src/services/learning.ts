import type {DecodedIdToken} from "firebase-admin/auth";
import {FieldValue, type DocumentReference} from "firebase-admin/firestore";
import {logger} from "firebase-functions";
import {z} from "zod";
import {firestoreDb} from "../admin";
import {forecastAll, type CityDemandForecast, type DemandEvent} from "../domain/demandForecast";
import {availabilityCityKey} from "../domain/dispatch";
import {complaintTopics, composeSupervisorReport, restaurantInsights, type Insight, type RestaurantStats} from "../domain/insights";
import {
  AD_CAPS,
  adDayOf,
  applyInterestEvents,
  attributedClick,
  cityOrderRate,
  foldRankModel,
  ORDER_WEIGHT,
  summarizeAdDays,
  type AdDay,
  type AdResults,
  type AppEvent,
  type InterestProfile,
  type RankModel,
} from "../domain/interests";
import {
  istHour,
  istWeekday,
  minutesPerStraightKm,
  predictPrep,
  predictTravel,
  trainPrepModel,
  trainTravelModel,
  type PrepModel,
  type PrepSample,
  type TravelModel,
  type TravelSample,
} from "../domain/learnedTimes";
import {haversineKm} from "../domain/order";
import {DomainError} from "../errors";
import type {TransactionLike} from "../firestoreTypes";
import type {CatalogRestaurant, OrderStatus, SavrivoOrder} from "../types";
import {istDayKey, istDayStart, SPONSORED_BOOKINGS_COLLECTION, SPONSORED_LISTINGS_COLLECTION} from "./sponsoredListings";

/**
 * Scraveit's learning loop. Four jobs:
 *
 *  1. Capture: when an order is delivered (or cancelled) its real timings become a training row
 *     (mlSamples), the ad that brought it gets credit or loses it, and a group order's real
 *     arrival times are written next to the plan (clusterDecisions.outcome).
 *  2. Signals: the customer app sends what was looked at, opened and added (recordAppEvents). They
 *     update the customer's interests, the city's ranking counts and the ad numbers.
 *  3. Nightly training (trainAll): prep and travel models, demand forecasts with rider-bonus
 *     suggestions, ranking memory, every restaurant's insights, and the supervisor's report.
 *  4. Serving: order creation and group-order planning read the live models (loadLearnedModels).
 *
 * Every write here is best-effort for the order flow: a failure is logged, never thrown into
 * checkout or delivery.
 */

export const ML_SAMPLES = "mlSamples";
export const ML_MODELS = "mlModels";
export const ML_REPORTS = "mlReports";
export const CUSTOMER_INTERESTS = "customerInterests";
export const RANK_DAILY = "rankDaily";
export const RANK_MODELS = "rankModels";
export const AD_EVENTS = "adEvents";
export const AD_STATS_DAILY = "adStatsDaily";
export const AD_CONVERSIONS = "adConversions";
export const BRAND_AD_STATS_DAILY = "brandAdStatsDaily";
export const RESTAURANT_INSIGHTS = "restaurantInsights";

const DAY_MS = 86_400_000;
const MODEL_CACHE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------------------------
// 1. Capture
// ---------------------------------------------------------------------------------------------

function firstEventAt(order: Pick<SavrivoOrder, "statusHistory">, status: OrderStatus, skipActorId?: string): number | null {
  let at: number | null = null;
  for (const event of Object.values(order.statusHistory ?? {})) {
    if (skipActorId && event?.actorId === skipActorId) continue;
    if (event?.status === status && Number.isFinite(Number(event.at))) at = at === null ? Number(event.at) : Math.min(at, Number(event.at));
  }
  return at;
}

export interface DeliverySample {
  orderId: string;
  restaurantId: string;
  cityKey: string;
  at: number;
  createdAt: number;
  items: number;
  statedPrep: number | null;
  prepStartAt: number | null;
  prepMinutes: number | null;
  prepSource: "ready" | "handover_after_wait" | null;
  km: number | null;
  travelMinutes: number | null;
  etaMin: number;
  etaMax: number;
  actualMinutes: number;
  acceptSeconds: number | null;
  availableRiders: number | null;
  clusterId: string | null;
  sharedTrip: boolean;
}

/**
 * The training row for one delivered order. Prep is measured from when the kitchen was due to start
 * (accepted, or the planned later start of a group order) to "Ready for pickup". Without a Ready tap
 * the handover time is used only when the rider had already been waiting 2+ minutes, because then
 * handover is when the food became ready; otherwise the food sat waiting and the true time is unknown.
 */
export function deliverySample(order: SavrivoOrder, cityKey: string, riderArrivedAt: number | null): DeliverySample | null {
  const deliveredAt = Number(order.deliveredAt ?? firstEventAt(order, "Delivered"));
  if (!Number.isFinite(deliveredAt) || order.status !== "Delivered") return null;
  const acceptedAt = firstEventAt(order, "Accepted");
  // A "Ready" written by the rider's parcel-photo pickup (the kitchen never tapped Order ready)
  // is the pickup moment, not a real ready time, so it never trains prep time.
  const readyAt = firstEventAt(order, "Ready for pickup", "rider_pickup");
  const handedAt = firstEventAt(order, "Handed to rider") ?? firstEventAt(order, "Out for delivery");
  const prepStartAt = acceptedAt === null ? null : Math.max(acceptedAt, Number(order.kitchenStartAt ?? 0));
  let prepEnd: number | null = null;
  let prepSource: DeliverySample["prepSource"] = null;
  if (prepStartAt !== null && readyAt !== null && readyAt > prepStartAt) {
    prepEnd = readyAt; prepSource = "ready";
  } else if (prepStartAt !== null && handedAt !== null && riderArrivedAt !== null && handedAt - riderArrivedAt >= 120_000 && handedAt > prepStartAt) {
    prepEnd = handedAt; prepSource = "handover_after_wait";
  }
  const basis = order.etaBasis;
  // The restaurant's own figure, even when the promise used a learned one.
  const statedLow = Number(basis?.statedPrepMinMinutes ?? basis?.prepMinMinutes);
  const statedHigh = Number(basis?.statedPrepMaxMinutes ?? basis?.prepMaxMinutes);
  const statedPrep = basis && Number.isFinite(statedLow) && Number.isFinite(statedHigh) ? (statedLow + statedHigh) / 2 : null;
  const to = order.address, from = order.restaurantLocation;
  const km = Number.isFinite(Number(to?.lat)) && Number.isFinite(Number(to?.lng)) && Number.isFinite(Number(from?.lat)) ?
    haversineKm({lat: Number(from.lat), lng: Number(from.lng)}, {lat: Number(to.lat), lng: Number(to.lng)}) : null;
  const trip = order.clusterTrip;
  const sharedTrip = Boolean(trip && trip.orderIds.length > 1);
  // A shared trip's earlier pickups ride via the next restaurant: not a clean ride time.
  const cleanRide = !sharedTrip || (trip && trip.stop === trip.orderIds.length - 1);
  return {
    orderId: order.id,
    restaurantId: order.restaurantId,
    cityKey,
    at: deliveredAt,
    createdAt: order.createdAt,
    items: order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    statedPrep,
    prepStartAt,
    prepMinutes: prepEnd !== null && prepStartAt !== null ? round1((prepEnd - prepStartAt) / 60_000) : null,
    prepSource,
    km: km === null ? null : Math.round(km * 1000) / 1000,
    travelMinutes: handedAt !== null && cleanRide && deliveredAt > handedAt ? round1((deliveredAt - handedAt) / 60_000) : null,
    etaMin: Number(order.etaMin) || 0,
    etaMax: Number(order.etaMax) || 0,
    actualMinutes: round1((deliveredAt - order.createdAt) / 60_000),
    acceptSeconds: acceptedAt !== null ? Math.round((acceptedAt - order.createdAt) / 1000) : null,
    availableRiders: basis && typeof basis.availableRiders === "number" ? basis.availableRiders : null,
    clusterId: order.clusterId ?? null,
    sharedTrip,
  };
}

async function cityKeyOf(restaurantId: string): Promise<string> {
  const snapshot = await firestoreDb.collection("restaurants").doc(restaurantId).get();
  return availabilityCityKey((snapshot.data() as {city?: string} | undefined)?.city);
}

/** Order reached Delivered or Cancelled: training row, ad credit, group-order outcome. Idempotent. */
export async function recordOrderOutcome(before: SavrivoOrder, order: SavrivoOrder): Promise<void> {
  const delivered = before.status !== "Delivered" && order.status === "Delivered";
  const cancelled = before.status !== "Cancelled" && order.status === "Cancelled";
  if (!delivered && !cancelled) return;
  const jobs: Array<Promise<unknown>> = [settleAdConversion(order, delivered ? "delivered" : "cancelled")];
  if (delivered) {
    jobs.push((async () => {
      const [cityKey, arrival] = await Promise.all([
        cityKeyOf(order.restaurantId),
        firestoreDb.collection("riderRestaurantArrivals").doc(order.id).get(),
      ]);
      const arrivedAt = Number((arrival.data() as {arrivedAt?: number} | undefined)?.arrivedAt);
      const sample = deliverySample(order, cityKey, Number.isFinite(arrivedAt) ? arrivedAt : null);
      if (sample) await firestoreDb.collection(ML_SAMPLES).doc(order.id).set(sample);
    })());
  }
  if (order.clusterId) jobs.push(recordClusterOutcome(order, delivered));
  const results = await Promise.allSettled(jobs);
  results.forEach((result) => {
    if (result.status === "rejected") logger.warn("LEARNING_OUTCOME_FAILED", {orderId: order.id, error: String(result.reason)});
  });
}

async function recordClusterOutcome(order: SavrivoOrder, delivered: boolean): Promise<void> {
  const ref = firestoreDb.collection("clusterDecisions").doc(String(order.clusterId));
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const data = snapshot.data() as {at?: number; features?: Record<string, unknown>; outcome?: Record<string, unknown> | null};
    const legs = {...((data.outcome?.legs as Record<string, unknown>) ?? {})};
    legs[order.id] = {
      restaurantId: order.restaurantId,
      status: delivered ? "delivered" : "cancelled",
      riderId: order.riderId ?? "",
      pickedUpAt: firstEventAt(order, "Handed to rider") ?? firstEventAt(order, "Out for delivery"),
      deliveredAt: delivered ? Number(order.deliveredAt ?? Date.now()) : null,
    };
    const size = Number(order.clusterSize ?? data.features?.legs ?? 0);
    const finished = Object.values(legs) as Array<{status: string; deliveredAt: number | null; riderId: string}>;
    const outcome: Record<string, unknown> = {legs, updatedAt: Date.now()};
    if (size && finished.length >= size) {
      const times = finished.map((leg) => leg.deliveredAt).filter((t): t is number => typeof t === "number");
      if (times.length) {
        const start = Number(data.at ?? order.createdAt);
        outcome.actualEtaMinutes = round1((Math.max(...times) - start) / 60_000);
        outcome.arrivalGapMinutes = round1((Math.max(...times) - Math.min(...times)) / 60_000);
        outcome.plannedEtaMinutes = Number(data.features?.etaMinutes ?? 0) || null;
        outcome.riders = new Set(finished.map((leg) => leg.riderId).filter(Boolean)).size;
        outcome.plannedRiders = Number(data.features?.riders ?? 0) || null;
      }
      outcome.complete = true;
    }
    transaction.set(ref, {outcome}, {merge: true});
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Serving learned models
// ---------------------------------------------------------------------------------------------

let modelCache: {at: number; prep: PrepModel | null; travel: TravelModel | null} | null = null;

/** The live models, only when they beat the rules they replace. Cached for ten minutes per instance. */
export async function loadLearnedModels(now = Date.now()): Promise<{prep: PrepModel | null; travel: TravelModel | null}> {
  if (modelCache && now - modelCache.at < MODEL_CACHE_MS) return modelCache;
  try {
    const [prep, travel] = await Promise.all([
      firestoreDb.collection(ML_MODELS).doc("prep").get(),
      firestoreDb.collection(ML_MODELS).doc("travel").get(),
    ]);
    const prepModel = prep.exists ? prep.data() as PrepModel : null;
    const travelModel = travel.exists ? travel.data() as TravelModel : null;
    modelCache = {at: now, prep: prepModel?.active ? prepModel : null, travel: travelModel?.active ? travelModel : null};
  } catch (error) {
    logger.warn("LEARNED_MODELS_UNAVAILABLE", {error: String(error)});
    modelCache = {at: now, prep: null, travel: null};
  }
  return modelCache;
}

export interface LearnedEta {
  prepLow: number;
  prepHigh: number;
  travelMinutes: number | null;
}

/** Learned prep window (20th-80th percentile) and ride time for one order, or null to keep the rules. */
export async function learnedEtaFor(input: {
  restaurant: Pick<CatalogRestaurant, "id" | "city" | "etaMin" | "etaMax" | "lat" | "lng">;
  items: number; customer: {lat: number; lng: number} | null; at: number;
}): Promise<LearnedEta | null> {
  const {prep, travel} = await loadLearnedModels(input.at);
  if (!prep && !travel) return null;
  const low = Number(input.restaurant.etaMin), high = Number(input.restaurant.etaMax);
  const stated = Number.isFinite(low) && Number.isFinite(high) && high > 0 ? (Math.max(3, low) + Math.max(3, high)) / 2 : 20;
  const hour = istHour(input.at);
  const predicted = prep ? predictPrep(prep, {restaurantId: input.restaurant.id, hour, items: input.items, statedMinutes: stated}) : null;
  let travelMinutes: number | null = null;
  if (travel && input.customer && Number.isFinite(input.customer.lat) && Number.isFinite(Number(input.restaurant.lat))) {
    const km = haversineKm({lat: Number(input.restaurant.lat), lng: Number(input.restaurant.lng)}, input.customer);
    travelMinutes = predictTravel(travel, {cityKey: availabilityCityKey(input.restaurant.city), hour, km});
  }
  return {
    prepLow: predicted ? predicted.p20 : Math.max(3, low || 15),
    prepHigh: predicted ? predicted.p80 : Math.max(3, high || 25),
    travelMinutes,
  };
}

/** Learned planner inputs for a group order: prep median per restaurant and riding minutes per km. */
export async function learnedPlanInputs(cityKey: string, at: number): Promise<{
  prepFor: ((restaurantId: string, items: number, statedMinutes: number) => number) | null;
  minutesPerKm: number | null;
}> {
  const {prep, travel} = await loadLearnedModels(at);
  const hour = istHour(at);
  return {
    prepFor: prep ? (restaurantId, items, statedMinutes) => predictPrep(prep, {restaurantId, hour, items, statedMinutes}).minutes : null,
    minutesPerKm: travel ? minutesPerStraightKm(travel, cityKey, hour) : null,
  };
}

/** Minutes until the nearest free, fresh rider could reach each point; null when none is known. */
export async function nearestRiderMinutes(cityKey: string, points: ReadonlyArray<{lat: number; lng: number}>,
  minutesPerKm: number | null, now = Date.now()): Promise<Array<number | null>> {
  try {
    const snapshot = await firestoreDb.collection("riderAvailability").where("cityKey", "==", cityKey).limit(300).get();
    const free = snapshot.docs.map((doc) => doc.data() as {online?: boolean; updatedAt?: number; lat?: number; lng?: number; activeOrderId?: string})
      .filter((rider) => rider.online === true && !rider.activeOrderId && now - Number(rider.updatedAt ?? 0) <= 120_000 &&
        Number.isFinite(Number(rider.lat)) && Number.isFinite(Number(rider.lng)));
    const perKm = minutesPerKm ?? 1.3 / 22 * 60;
    return points.map((point) => {
      if (!free.length) return null;
      const km = Math.min(...free.map((rider) => haversineKm({lat: Number(rider.lat), lng: Number(rider.lng)}, point)));
      return round1(km * perKm + 2);
    });
  } catch (error) {
    logger.warn("NEAREST_RIDER_LOOKUP_FAILED", {cityKey, error: String(error)});
    return points.map(() => null);
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Signals from the customer app, and ad attribution
// ---------------------------------------------------------------------------------------------

export const recordAppEventsSchema = z.object({
  events: z.array(z.object({
    t: z.enum(["imp", "open", "add", "adImp", "adClick", "brandImp", "brandClick"]),
    rid: z.string().trim().min(1).max(128).optional(),
    adId: z.string().trim().min(1).max(128).optional(),
    ms: z.number().int().min(0).max(30 * 60_000).optional(),
    cuisines: z.array(z.string().trim().max(60)).max(3).optional(),
    city: z.string().trim().max(120).optional(),
    at: z.number().int().positive(),
  }).strict()).min(1).max(80),
}).strict();
export type RecordAppEventsInput = z.infer<typeof recordAppEventsSchema>;

let sponsoredCache: {at: number; rows: Array<{restaurantId: string; startAt: number; endAt: number}>} | null = null;
async function sponsoredRows(now: number) {
  if (sponsoredCache && now - sponsoredCache.at < 60_000) return sponsoredCache.rows;
  const snapshot = await firestoreDb.collection(SPONSORED_LISTINGS_COLLECTION).where("endAt", ">", now - 2 * DAY_MS).get();
  const rows = snapshot.docs.map((doc) => doc.data() as {restaurantId: string; startAt: number; endAt: number});
  sponsoredCache = {at: now, rows};
  return rows;
}
export function wasSponsored(rows: ReadonlyArray<{restaurantId: string; startAt: number; endAt: number}>, restaurantId: string, at: number): boolean {
  return rows.some((row) => row.restaurantId === restaurantId && Number(row.startAt) <= at && at < Number(row.endAt));
}

let brandCache: {at: number; ids: Set<string>} | null = null;
async function brandAdIds(now: number): Promise<Set<string>> {
  if (brandCache && now - brandCache.at < 5 * 60_000) return brandCache.ids;
  const snapshot = await firestoreDb.collection("localAds").get();
  brandCache = {at: now, ids: new Set(snapshot.docs.map((doc) => doc.id))};
  return brandCache.ids;
}

interface AdTally { impressions: number; clicks: number; viewMs: number; clickTimes: number[] }

/** Applies one customer's ad events for one store (or brand ad) and day, inside the per-day caps. */
export function cappedAdIncrement(existing: Partial<AdTally> | null, events: readonly AppEvent[]): {next: AdTally; inc: {impressions: number; clicks: number; viewMs: number}; firstSeen: boolean} {
  const next: AdTally = {
    impressions: Number(existing?.impressions ?? 0), clicks: Number(existing?.clicks ?? 0),
    viewMs: Number(existing?.viewMs ?? 0), clickTimes: [...(existing?.clickTimes ?? [])],
  };
  const inc = {impressions: 0, clicks: 0, viewMs: 0};
  for (const event of events) {
    const isClick = event.t === "adClick" || event.t === "brandClick";
    if (isClick) {
      if (next.clicks >= AD_CAPS.clicks) continue;
      next.clicks += 1; inc.clicks += 1; next.clickTimes.push(event.at);
    } else {
      if ((Number(event.ms) || 0) < 1000 || next.impressions >= AD_CAPS.impressions) continue;
      const ms = Math.min(60_000, Number(event.ms) || 0);
      next.impressions += 1; inc.impressions += 1; next.viewMs += ms; inc.viewMs += ms;
    }
  }
  next.clickTimes = next.clickTimes.slice(-AD_CAPS.clicks);
  return {next, inc, firstSeen: !existing && inc.impressions + inc.clicks > 0};
}

/** The customer app's batch of signals (sent every minute or so, and when the app goes to the background). */
export async function recordAppEvents(uid: string, input: RecordAppEventsInput, now = Date.now()): Promise<{accepted: number}> {
  const events = input.events.filter((event) => event.at <= now + 5 * 60_000 && now - event.at <= 2 * DAY_MS)
    .map((event) => ({...event, at: Math.min(event.at, now)})) as AppEvent[];
  if (!events.length) return {accepted: 0};
  const interestRef = firestoreDb.collection(CUSTOMER_INTERESTS).doc(uid);
  let throttled = false;
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(interestRef);
    const current = snapshot.exists ? snapshot.data() as InterestProfile & {lastEventsAt?: number} : null;
    throttled = Boolean(current?.lastEventsAt && now - current.lastEventsAt < 10_000);
    transaction.set(interestRef, {...applyInterestEvents(current, events, now), lastEventsAt: now});
  });

  // City ranking counts. A burst faster than one batch per 10 seconds still updates the customer's
  // own interests but is not counted for the city, and each batch counts a store at most a few times.
  const writes: Array<Promise<unknown>> = [];
  if (!throttled) {
    const rank: Record<string, Record<string, {imp: number; open: number}>> = {};
    for (const event of events) {
      if (!event.rid || !event.city || (event.t !== "imp" && event.t !== "open" && event.t !== "adImp")) continue;
      const key = `${availabilityCityKey(event.city)}_${istDayKey(event.at)}`;
      const row = ((rank[key] ??= {})[event.rid] ??= {imp: 0, open: 0});
      if (event.t === "open") row.open = Math.min(2, row.open + 1);
      else if ((event.ms ?? 0) >= 1000) row.imp = Math.min(3, row.imp + 1);
    }
    for (const [key, restaurants] of Object.entries(rank)) {
      const [cityKey, day] = [key.slice(0, key.lastIndexOf("_")), key.slice(key.lastIndexOf("_") + 1)];
      const update: Record<string, Record<string, FieldValue>> = {};
      for (const [rid, counts] of Object.entries(restaurants)) {
        update[rid] = {
          ...(counts.imp ? {imp: FieldValue.increment(counts.imp)} : {}),
          ...(counts.open ? {open: FieldValue.increment(counts.open)} : {}),
        };
      }
      writes.push(firestoreDb.collection(RANK_DAILY).doc(key).set({cityKey, day, dayStart: istDayStart(day), folded: false, restaurants: update}, {merge: true}));
    }
  }

  // Ads: only stores that really had top placement at that moment, and only brand ads that exist.
  const adEvents = events.filter((event) => event.t === "adImp" || event.t === "adClick");
  const brandEvents = events.filter((event) => event.t === "brandImp" || event.t === "brandClick");
  if (adEvents.length) {
    const rows = await sponsoredRows(now);
    const groups: Record<string, AppEvent[]> = {};
    for (const event of adEvents) {
      if (!event.rid || !wasSponsored(rows, event.rid, event.at)) continue;
      (groups[`${event.rid}|${istDayKey(event.at)}`] ??= []).push(event);
    }
    for (const [key, group] of Object.entries(groups)) {
      const [rid, day] = key.split("|") as [string, string];
      writes.push(tallyAd(`${uid}_${rid}_${day}`, `${rid}_${day}`, AD_STATS_DAILY, {restaurantId: rid, uid, day}, group));
    }
  }
  if (brandEvents.length) {
    const ids = await brandAdIds(now);
    const groups: Record<string, AppEvent[]> = {};
    for (const event of brandEvents) {
      if (!event.adId || !ids.has(event.adId)) continue;
      (groups[`${event.adId}|${istDayKey(event.at)}`] ??= []).push(event);
    }
    for (const [key, group] of Object.entries(groups)) {
      const [adId, day] = key.split("|") as [string, string];
      writes.push(tallyAd(`b_${uid}_${adId}_${day}`, `${adId}_${day}`, BRAND_AD_STATS_DAILY, {adId, uid, day}, group));
    }
  }
  const results = await Promise.allSettled(writes);
  results.forEach((result) => {
    if (result.status === "rejected") logger.warn("APP_EVENTS_WRITE_FAILED", {uid, error: String(result.reason)});
  });
  return {accepted: events.length};
}

async function tallyAd(eventDocId: string, statsDocId: string, statsCollection: string,
  identity: {restaurantId?: string; adId?: string; uid: string; day: string}, events: readonly AppEvent[]): Promise<void> {
  const eventRef = firestoreDb.collection(AD_EVENTS).doc(eventDocId);
  const statsRef = firestoreDb.collection(statsCollection).doc(statsDocId);
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(eventRef);
    const {next, inc, firstSeen} = cappedAdIncrement(snapshot.exists ? snapshot.data() as Partial<AdTally> : null, events);
    if (!inc.impressions && !inc.clicks) return;
    transaction.set(eventRef, {...identity, ...next, updatedAt: Date.now()});
    transaction.set(statsRef, {
      ...(identity.restaurantId ? {restaurantId: identity.restaurantId} : {adId: identity.adId}),
      day: identity.day,
      impressions: FieldValue.increment(inc.impressions),
      clicks: FieldValue.increment(inc.clicks),
      viewMs: FieldValue.increment(inc.viewMs),
      ...(firstSeen ? {reach: FieldValue.increment(1)} : {}),
      updatedAt: Date.now(),
    }, {merge: true});
  });
}

/** When the customer last tapped this store's Ad within the attribution window, if they did. */
export async function adClickBefore(uid: string, restaurantId: string, at: number): Promise<number | null> {
  try {
    const days = [istDayKey(at), istDayKey(at - DAY_MS)];
    const snapshots = await Promise.all(days.map((day) => firestoreDb.collection(AD_EVENTS).doc(`${uid}_${restaurantId}_${day}`).get()));
    const clicks = snapshots.flatMap((snapshot) => ((snapshot.data() as {clickTimes?: number[]} | undefined)?.clickTimes ?? []).map(Number));
    return attributedClick(clicks, at);
  } catch (error) {
    logger.warn("AD_ATTRIBUTION_LOOKUP_FAILED", {uid, restaurantId, error: String(error)});
    return null;
  }
}

/** Inside the order transaction: the order counts for the Ad that brought it. */
export function writeAdConversion(transaction: TransactionLike, order: Pick<SavrivoOrder, "id" | "customerId" | "restaurantId" | "createdAt">,
  clickAt: number, foodValue: number): void {
  const day = istDayKey(clickAt);
  transaction.set(firestoreDb.collection(AD_CONVERSIONS).doc(order.id), {
    orderId: order.id, customerId: order.customerId, restaurantId: order.restaurantId,
    clickAt, day, orderAt: order.createdAt, sales: round2(foodValue), status: "placed",
  });
  transaction.set(firestoreDb.collection(AD_STATS_DAILY).doc(`${order.restaurantId}_${day}`), {
    restaurantId: order.restaurantId, day,
    orders: FieldValue.increment(1), sales: FieldValue.increment(round2(foodValue)), updatedAt: order.createdAt,
  }, {merge: true});
}

async function settleAdConversion(order: SavrivoOrder, status: "delivered" | "cancelled"): Promise<void> {
  if (!order.adClickAt) return;
  const ref = firestoreDb.collection(AD_CONVERSIONS).doc(order.id);
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const conversion = snapshot.data() as {status: string; day: string; sales: number; restaurantId: string};
    if (conversion.status !== "placed") return;
    transaction.update(ref, {status, settledAt: Date.now()});
    transaction.set(firestoreDb.collection(AD_STATS_DAILY).doc(`${conversion.restaurantId}_${conversion.day}`), status === "delivered" ?
      {deliveredOrders: FieldValue.increment(1), deliveredSales: FieldValue.increment(Number(conversion.sales) || 0)} :
      {cancelledOrders: FieldValue.increment(1)}, {merge: true});
  });
}

/** After an order is placed: the strongest taste signal, and an "order" for the city's ranking. */
export async function noteOrderPlaced(order: SavrivoOrder, restaurant: CatalogRestaurant & {cuisines?: unknown}): Promise<void> {
  const cuisines = Array.isArray(restaurant.cuisines) ? (restaurant.cuisines as unknown[]).map(String).slice(0, 3) : [];
  const cityKey = availabilityCityKey(restaurant.city);
  const day = istDayKey(order.createdAt);
  const interestRef = firestoreDb.collection(CUSTOMER_INTERESTS).doc(order.customerId);
  await Promise.allSettled([
    firestoreDb.runTransaction(async (transaction: TransactionLike) => {
      const snapshot = await transaction.get(interestRef);
      const current = snapshot.exists ? snapshot.data() as InterestProfile & {lastEventsAt?: number} : null;
      transaction.set(interestRef, {
        ...applyInterestEvents(current, [], order.createdAt, [{rid: order.restaurantId, cuisines, weight: ORDER_WEIGHT}]),
        ...(current?.lastEventsAt ? {lastEventsAt: current.lastEventsAt} : {}),
      });
    }),
    firestoreDb.collection(RANK_DAILY).doc(`${cityKey}_${day}`).set({
      cityKey, day, dayStart: istDayStart(day), folded: false,
      restaurants: {[order.restaurantId]: {order: FieldValue.increment(1)}},
    }, {merge: true}),
  ]).then((results) => results.forEach((result) => {
    if (result.status === "rejected") logger.warn("ORDER_SIGNAL_FAILED", {orderId: order.id, error: String(result.reason)});
  }));
}

/** Ad results for one store, per booking and in total (for the Ads page). */
/**
 * What a booking has cost so far, rupees before GST: only the days that have started count, so an
 * upcoming or half-run booking never drags down "earned per rupee spent".
 */
export function adSpentSoFar(booking: {startDay: string; endDay: string; pricePaise: number; status: string}, now: number): number {
  if (booking.status === "cancelled") return 0;
  const today = istDayKey(now);
  if (booking.startDay > today) return 0;
  const days = (from: string, to: string) => Math.round((istDayStart(to) - istDayStart(from)) / DAY_MS) + 1;
  const total = Math.max(1, days(booking.startDay, booking.endDay));
  const ran = Math.min(total, days(booking.startDay, booking.endDay < today ? booking.endDay : today));
  return Math.round(booking.pricePaise * ran / total) / 100;
}

export async function adResultsForRestaurant(restaurantId: string,
  bookings: ReadonlyArray<{bookingId: string; startDay: string; endDay: string; pricePaise: number; status: string}>, now = Date.now()):
  Promise<{total: AdResults; byBooking: Record<string, AdResults>; daily: AdDay[]}> {
  const firstDay = bookings.filter((b) => b.status !== "cancelled").reduce((min, b) => (b.startDay < min ? b.startDay : min), "9999-12-31");
  if (firstDay === "9999-12-31") {
    const empty = summarizeAdDays([], 0);
    return {total: empty, byBooking: {}, daily: []};
  }
  const snapshot = await firestoreDb.collection(AD_STATS_DAILY).where("restaurantId", "==", restaurantId).where("day", ">=", firstDay).get();
  const days = snapshot.docs.map((doc) => adDayOf(doc.data() as Record<string, unknown>, String((doc.data() as {day?: string}).day ?? "")));
  const byBooking: Record<string, AdResults> = {};
  let spent = 0;
  const counted = new Set<string>();
  for (const booking of bookings) {
    if (booking.status === "cancelled") continue;
    const inRange = days.filter((d) => d.day >= booking.startDay && d.day <= booking.endDay);
    const cost = adSpentSoFar(booking, now);
    byBooking[booking.bookingId] = summarizeAdDays(inRange, cost);
    spent += cost;
    inRange.forEach((d) => counted.add(d.day));
  }
  const daily = days.filter((d) => counted.has(d.day)).sort((a, b) => a.day.localeCompare(b.day));
  return {total: summarizeAdDays(daily, spent), byBooking, daily};
}

// ---------------------------------------------------------------------------------------------
// 4. Nightly training
// ---------------------------------------------------------------------------------------------

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] as number : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

interface OrderRow {
  id: string; restaurantId: string; customerId: string; createdAt: number; status: string;
  cancellationKind?: string; cancelReason?: string; etaMax?: number; deliveredAt?: number;
  availableRiders: number | null; clusterId?: string; acceptedAt: number | null;
}

async function recentOrders(since: number): Promise<OrderRow[]> {
  const snapshot = await firestoreDb.collection("orders").where("createdAt", ">=", since)
    .select("restaurantId", "customerId", "createdAt", "status", "cancellationKind", "cancelReason", "etaMax", "deliveredAt",
      "etaBasis", "clusterId", "statusHistory", "clusterHold")
    .limit(30_000).get();
  return snapshot.docs.flatMap((doc) => {
    const data = doc.data() as SavrivoOrder;
    if (data.clusterHold === true) return [];
    return [{
      id: doc.id, restaurantId: data.restaurantId, customerId: data.customerId, createdAt: Number(data.createdAt),
      status: String(data.status), cancellationKind: data.cancellationKind, cancelReason: data.cancelReason,
      etaMax: Number(data.etaMax) || undefined, deliveredAt: Number(data.deliveredAt) || undefined,
      availableRiders: typeof data.etaBasis?.availableRiders === "number" ? data.etaBasis.availableRiders : null,
      clusterId: data.clusterId, acceptedAt: firstEventAt(data, "Accepted"),
    }];
  });
}

export interface TrainingSummary {
  samples: number;
  prepActive: boolean;
  travelActive: boolean;
  cities: number;
  restaurants: number;
  reportHeadline: string;
}

/** Everything the night does, in order. Safe to run again at any time (each step overwrites its own output). */
export async function trainAll(now = Date.now()): Promise<TrainingSummary> {
  const sampleSnapshot = await firestoreDb.collection(ML_SAMPLES).where("at", ">=", now - 90 * DAY_MS).limit(50_000).get();
  const samples = sampleSnapshot.docs.map((doc) => doc.data() as DeliverySample);
  const prepSamples: PrepSample[] = samples.flatMap((s) => s.prepMinutes !== null && s.statedPrep !== null && s.prepStartAt !== null ? [{
    restaurantId: s.restaurantId, at: s.at, hour: istHour(s.prepStartAt), items: s.items, statedMinutes: s.statedPrep, minutes: s.prepMinutes,
  }] : []);
  const travelSamples: TravelSample[] = samples.flatMap((s) => s.travelMinutes !== null && s.km !== null ? [{
    cityKey: s.cityKey, at: s.at, hour: istHour(s.at - s.travelMinutes * 60_000), km: s.km, minutes: s.travelMinutes,
  }] : []);
  const prep = trainPrepModel(prepSamples, now);
  const travel = trainTravelModel(travelSamples, now);
  await Promise.all([
    firestoreDb.collection(ML_MODELS).doc("prep").set(prep),
    firestoreDb.collection(ML_MODELS).doc("travel").set(travel),
  ]);
  modelCache = null;
  logger.info("ML_MODELS_TRAINED", {prepSamples: prepSamples.length, prepActive: prep.active, prepMetrics: prep.metrics,
    travelSamples: travelSamples.length, travelActive: travel.active, travelMetrics: travel.metrics});

  const [orders, restaurantsSnapshot] = await Promise.all([
    recentOrders(now - 56 * DAY_MS),
    firestoreDb.collection("restaurants").select("name", "city", "archived", "etaMin", "etaMax").get(),
  ]);
  const restaurants = new Map(restaurantsSnapshot.docs.map((doc) => [doc.id, doc.data() as {name?: string; city?: string; archived?: boolean; etaMin?: number; etaMax?: number}]));
  const cityOf = (rid: string) => availabilityCityKey(restaurants.get(rid)?.city);

  // Demand forecasts and rider-bonus suggestions.
  const demandEvents: DemandEvent[] = orders.map((o) => ({at: o.createdAt, cityKey: cityOf(o.restaurantId), availableRiders: o.availableRiders}));
  const demand = forecastAll(demandEvents.filter((e) => e.cityKey !== "unknown"), now);

  // Ranking memory: fold finished days into each city's model.
  const today = istDayKey(now);
  const rankSnapshot = await firestoreDb.collection(RANK_DAILY).where("folded", "==", false).limit(500).get();
  const rankByCity: Record<string, Array<{ref: DocumentReference; day: number; restaurants: Record<string, {imp?: number; open?: number; order?: number}>}>> = {};
  for (const doc of rankSnapshot.docs) {
    const data = doc.data() as {cityKey: string; day: string; restaurants?: Record<string, {imp?: number; open?: number; order?: number}>};
    if (data.day >= today) continue;
    (rankByCity[data.cityKey] ??= []).push({ref: doc.ref, day: istDayStart(data.day) + DAY_MS, restaurants: data.restaurants ?? {}});
  }
  const weekRanking = {impressions: 0, opens: 0, orders: 0};
  for (const [cityKey, days] of Object.entries(rankByCity)) {
    const ref = firestoreDb.collection(RANK_MODELS).doc(cityKey);
    const current = await ref.get();
    const folded: RankModel = foldRankModel(current.exists ? current.data() as RankModel : null, days, now);
    const batch = firestoreDb.batch();
    batch.set(ref, {...folded, cityKey, cityRate: Math.round(cityOrderRate(folded) * 10_000) / 10_000});
    days.forEach((day) => batch.update(day.ref, {folded: true}));
    await batch.commit();
  }
  const weekRankSnapshot = await firestoreDb.collection(RANK_DAILY).where("dayStart", ">=", istDayStart(istDayKey(now - 7 * DAY_MS))).get();
  for (const doc of weekRankSnapshot.docs) {
    for (const counts of Object.values((doc.data() as {restaurants?: Record<string, {imp?: number; open?: number; order?: number}>}).restaurants ?? {})) {
      weekRanking.impressions += Number(counts.imp) || 0; weekRanking.opens += Number(counts.open) || 0; weekRanking.orders += Number(counts.order) || 0;
    }
  }

  // Restaurant insights.
  const since30 = now - 30 * DAY_MS;
  const [reviewsSnapshot, adStatsSnapshot, bookingsSnapshot, brandStatsSnapshot, brandAdsSnapshot, clusterSnapshot] = await Promise.all([
    firestoreDb.collection("reviews").where("createdAt", ">=", since30).limit(20_000).get(),
    firestoreDb.collection(AD_STATS_DAILY).where("day", ">=", istDayKey(since30)).get(),
    firestoreDb.collection(SPONSORED_BOOKINGS_COLLECTION).where("endAt", ">=", since30).get(),
    firestoreDb.collection(BRAND_AD_STATS_DAILY).where("day", ">=", istDayKey(now - 7 * DAY_MS)).get(),
    firestoreDb.collection("localAds").get(),
    firestoreDb.collection("clusterDecisions").where("at", ">=", now - 7 * DAY_MS).get(),
  ]);
  const reviewsBy: Record<string, Array<{rating: number; comment: string}>> = {};
  for (const doc of reviewsSnapshot.docs) {
    const data = doc.data() as {restaurantId?: string; rating?: number; restaurantRating?: number; comment?: string; text?: string};
    const rating = Number(data.rating ?? data.restaurantRating);
    if (!data.restaurantId || !Number.isFinite(rating) || rating <= 0) continue;
    (reviewsBy[data.restaurantId] ??= []).push({rating, comment: String(data.comment ?? data.text ?? "")});
  }
  const adDaysBy: Record<string, AdDay[]> = {};
  for (const doc of adStatsSnapshot.docs) {
    const data = doc.data() as Record<string, unknown>;
    (adDaysBy[String(data.restaurantId)] ??= []).push(adDayOf(data, String(data.day)));
  }
  const spentBy: Record<string, number> = {};
  for (const doc of bookingsSnapshot.docs) {
    const data = doc.data() as {restaurantId?: string; status?: string; pricePaise?: number; startAt?: number; endAt?: number; days?: number};
    if (!data.restaurantId || data.status === "cancelled") continue;
    // Only the part of the booking inside the last 30 days.
    const days = Math.max(1, Number(data.days) || 1);
    const overlap = Math.max(0, Math.min(now, Number(data.endAt)) - Math.max(since30, Number(data.startAt))) / DAY_MS;
    spentBy[data.restaurantId] = (spentBy[data.restaurantId] ?? 0) + (Number(data.pricePaise) || 0) / 100 * Math.min(1, overlap / days);
  }
  const ordersBy: Record<string, OrderRow[]> = {};
  for (const order of orders) if (order.createdAt >= since30) (ordersBy[order.restaurantId] ??= []).push(order);
  const samplesBy: Record<string, DeliverySample[]> = {};
  for (const s of samples) if (s.at >= since30) (samplesBy[s.restaurantId] ??= []).push(s);

  const live = [...restaurants.entries()].filter(([, r]) => r.archived !== true);
  const issueCounts: Record<string, {title: string; stores: number}> = {};
  let needingAction = 0;
  const weakAdStores: Array<{name: string; roas: number; spent: number}> = [];
  let adTotalSpent = 0;
  const allAdDays: AdDay[] = [];
  const insightFor = async ([rid, info]: [string, {name?: string; city?: string; archived?: boolean}]) => {
    const menu = await firestoreDb.collection("menus").doc(rid).collection("items").get().catch(() => null);
    const items = (menu?.docs ?? []).map((doc) => doc.data() as {archived?: boolean; available?: boolean; image?: string; imageUrl?: string; photo?: string; imageThumb?: string})
      .filter((item) => item.archived !== true);
    const rows = ordersBy[rid] ?? [];
    const delivered = rows.filter((o) => o.status === "Delivered");
    const reviews = reviewsBy[rid] ?? [];
    const complaints: Record<string, number> = {};
    for (const review of reviews) if (review.rating <= 3) for (const topic of complaintTopics(review.comment)) complaints[topic] = (complaints[topic] ?? 0) + 1;
    const rejected = rows.filter((o) => o.cancellationKind === "restaurant_rejected");
    const rejectReasons: Record<string, number> = {};
    for (const o of rejected) { const reason = (o.cancelReason || "No reason given").slice(0, 60); rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1; }
    const timed = (samplesBy[rid] ?? []).filter((s) => s.prepMinutes !== null);
    const customers: Record<string, number> = {};
    for (const o of delivered) customers[o.customerId] = (customers[o.customerId] ?? 0) + 1;
    const customerCount = Object.keys(customers).length;
    const spent = Math.round((spentBy[rid] ?? 0) * 100) / 100;
    const adDays = adDaysBy[rid] ?? [];
    const ads = spent > 0 || adDays.length ? summarizeAdDays(adDays, spent) : null;
    if (ads && spent > 0) { adTotalSpent += spent; allAdDays.push(...adDays); if (ads.impressions >= 200 && ads.roas < 1) weakAdStores.push({name: String(info.name ?? rid), roas: ads.roas, spent}); }
    const stats: RestaurantStats = {
      restaurantId: rid, name: String(info.name ?? ""), days: 30,
      orders: rows.length, delivered: delivered.length,
      restaurantRejected: rejected.length,
      customerCancelled: rows.filter((o) => o.cancellationKind === "customer_cancelled").length,
      rejectReasons,
      acceptSecondsMedian: median(rows.flatMap((o) => o.acceptedAt !== null ? [(o.acceptedAt - o.createdAt) / 1000] : [])),
      prepSamples: timed.length,
      prepMedian: median(timed.map((s) => s.prepMinutes as number)),
      prepStated: median(timed.flatMap((s) => s.statedPrep !== null ? [s.statedPrep] : [])),
      lateShare: delivered.length ? delivered.filter((o) => o.deliveredAt && o.etaMax && o.deliveredAt - o.createdAt > o.etaMax * 60_000).length / delivered.length : null,
      ratingAvg: reviews.length ? Math.round(reviews.reduce((a, r) => a + r.rating, 0) / reviews.length * 10) / 10 : null,
      ratingCount: reviews.length,
      complaints,
      menuItems: items.length,
      itemsWithoutPhoto: items.filter((item) => !(item.image || item.imageUrl || item.photo || item.imageThumb)).length,
      itemsUnavailable: items.filter((item) => item.available === false).length,
      repeatShare: customerCount ? Object.values(customers).filter((n) => n > 1).length / customerCount : null,
      ads,
    };
    const insights: Insight[] = restaurantInsights(stats);
    if (insights.some((i) => i.severity === "act")) needingAction += 1;
    for (const insight of insights) {
      if (insight.severity === "good") continue;
      const key = insight.id.replace(/^complaint-.*/, "complaint");
      const entry = issueCounts[key] ?? (issueCounts[key] = {title: issueTitle(key), stores: 0});
      entry.stores += 1;
    }
    await firestoreDb.collection(RESTAURANT_INSIGHTS).doc(rid).set({
      restaurantId: rid, generatedAt: now, insights,
      stats: {orders: stats.orders, delivered: stats.delivered, ratingAvg: stats.ratingAvg, ratingCount: stats.ratingCount,
        prepMedian: stats.prepMedian, prepStated: stats.prepStated, lateShare: stats.lateShare, repeatShare: stats.repeatShare,
        acceptSecondsMedian: stats.acceptSecondsMedian},
      ...(ads ? {ads} : {}),
    });
  };
  for (let index = 0; index < live.length; index += 10) await Promise.all(live.slice(index, index + 10).map(insightFor));

  // Group orders this week, and riders' answers to extra pickups.
  let clusterOrders = 0, sharedTrips = 0;
  const gaps: number[] = [], etaErrors: number[] = [];
  for (const doc of clusterSnapshot.docs) {
    const data = doc.data() as {features?: Record<string, unknown>; outcome?: Record<string, unknown> | null};
    clusterOrders += 1;
    const legs = Number(data.features?.legs ?? 0), riders = Number(data.features?.riders ?? 0);
    if (legs > riders) sharedTrips += legs - riders;
    if (typeof data.outcome?.arrivalGapMinutes === "number") gaps.push(data.outcome.arrivalGapMinutes);
    if (typeof data.outcome?.actualEtaMinutes === "number" && typeof data.outcome?.plannedEtaMinutes === "number") {
      etaErrors.push(Math.abs(data.outcome.actualEtaMinutes - data.outcome.plannedEtaMinutes));
    }
  }
  const queueSnapshot = await firestoreDb.collection("dispatchQueue").where("createdAt", ">=", now - 7 * DAY_MS)
    .select("status", "claim", "bundle").get().catch(() => null);
  let bundleOffers = 0, bundleAccepted = 0;
  for (const doc of queueSnapshot?.docs ?? []) {
    const data = doc.data() as {status?: string; claim?: {riderId?: string}; bundle?: {riderId?: string}};
    if (!data.bundle?.riderId) continue;
    bundleOffers += 1;
    if (data.status === "assigned" && data.claim?.riderId === data.bundle?.riderId) bundleAccepted += 1;
  }

  // On-time delivery this week.
  const weekDelivered = samples.filter((s) => s.at >= now - 7 * DAY_MS);
  const late = weekDelivered.filter((s) => s.etaMax > 0 && s.actualMinutes > s.etaMax);

  const adTotals = summarizeAdDays(allAdDays, adTotalSpent);
  const brandTitles = new Map(brandAdsSnapshot.docs.map((doc) => [doc.id, String((doc.data() as {title?: string}).title ?? doc.id)]));
  const brandTotals: Record<string, {title: string; impressions: number; reach: number; clicks: number}> = {};
  for (const doc of brandStatsSnapshot.docs) {
    const data = doc.data() as {adId?: string; impressions?: number; reach?: number; clicks?: number};
    if (!data.adId) continue;
    const row = brandTotals[data.adId] ?? (brandTotals[data.adId] = {title: brandTitles.get(data.adId) ?? data.adId, impressions: 0, reach: 0, clicks: 0});
    row.impressions += Number(data.impressions) || 0; row.reach += Number(data.reach) || 0; row.clicks += Number(data.clicks) || 0;
  }

  const report = composeSupervisorReport({
    now, prep, travel,
    eta: {delivered: weekDelivered.length, onTime: weekDelivered.length - late.length,
      avgLateMinutes: late.length ? late.reduce((a, s) => a + (s.actualMinutes - s.etaMax), 0) / late.length : 0},
    demand,
    ads: {...adTotals, stores: Object.keys(spentBy).length},
    weakAdStores: weakAdStores.sort((a, b) => a.roas - b.roas),
    brandAds: Object.values(brandTotals).sort((a, b) => b.impressions - a.impressions),
    clusters: {orders: clusterOrders, sharedTrips, bundleOffers, bundleAccepted,
      avgArrivalGapMinutes: gaps.length ? round1(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
      etaErrorMinutes: etaErrors.length ? round1(etaErrors.reduce((a, b) => a + b, 0) / etaErrors.length) : null},
    restaurants: {total: live.length, needingAction, topIssues: Object.values(issueCounts).sort((a, b) => b.stores - a.stores)},
    ranking: weekRanking,
  });
  const latest = {
    report,
    models: {prep: {active: prep.active, metrics: prep.metrics, restaurants: Object.keys(prep.restaurants).length},
      travel: {active: travel.active, metrics: travel.metrics, cities: Object.keys(travel.cities).length}},
    demand: demand.map(slimForecast),
    ads: {...adTotals, stores: Object.keys(spentBy).length},
    brandAds: Object.entries(brandTotals).map(([adId, row]) => ({adId, ...row})),
    generatedAt: now,
  };
  const writes: Array<Promise<unknown>> = [firestoreDb.collection(ML_REPORTS).doc("latest").set(latest)];
  // One archived copy per week (the run on Monday, India time).
  if (istWeekday(now) === 0) writes.push(firestoreDb.collection(ML_REPORTS).doc(`week_${istDayKey(now)}`).set(latest));
  await Promise.all(writes);
  logger.info("SUPERVISOR_REPORT_WRITTEN", {headline: report.headline, suggestions: report.suggestions.length});
  return {samples: samples.length, prepActive: prep.active, travelActive: travel.active, cities: demand.length, restaurants: live.length,
    reportHeadline: report.headline};
}

function slimForecast(city: CityDemandForecast) {
  return {cityKey: city.cityKey, expectedNext24: city.expectedNext24, busiest: city.busiest, bonuses: city.bonuses, metrics: city.metrics,
    next24: city.next24.map((h) => ({at: h.at, label: h.label, expected: h.expected, shortRate: h.shortRate}))};
}

function issueTitle(id: string): string {
  return ({
    "no-orders": "No orders in 30 days", "rejections": "Declining many orders", "slow-accept": "Slow to accept orders",
    "prep-slow": "Food takes longer than stated", "late": "Many late deliveries", "rating": "Low rating",
    "complaint": "Repeated complaints in reviews", "photos": "Dishes without photos", "unavailable": "Many dishes switched off",
    "ads-weak": "Ads not paying back",
  } as Record<string, string>)[id] ?? id;
}

// ---------------------------------------------------------------------------------------------
// Admin reports
// ---------------------------------------------------------------------------------------------

function requireStaff(token: DecodedIdToken): void {
  if (token.savrivoRole !== "owner" && token.savrivoRole !== "ops_admin") throw new DomainError("permission-denied", "Only Scraveit staff can see this.");
}

export const adsReportSchema = z.object({days: z.number().int().min(1).max(90).default(30)}).strict();

/**
 * Every store's and brand's ad results for a period: the page shown to advertisers ("these stores
 * earned ₹X from ₹Y of ads"), with a CSV copy.
 */
export async function getAdsReport(token: DecodedIdToken, input: {days: number}, now = Date.now()) {
  requireStaff(token);
  const since = istDayKey(now - (input.days - 1) * DAY_MS);
  const [stats, bookings, brandStats, brandAds, restaurants] = await Promise.all([
    firestoreDb.collection(AD_STATS_DAILY).where("day", ">=", since).get(),
    firestoreDb.collection(SPONSORED_BOOKINGS_COLLECTION).where("endAt", ">=", istDayStart(since)).get(),
    firestoreDb.collection(BRAND_AD_STATS_DAILY).where("day", ">=", since).get(),
    firestoreDb.collection("localAds").get(),
    firestoreDb.collection("restaurants").select("name", "city").get(),
  ]);
  const names = new Map(restaurants.docs.map((doc) => [doc.id, doc.data() as {name?: string; city?: string}]));
  const daysBy: Record<string, AdDay[]> = {};
  for (const doc of stats.docs) {
    const data = doc.data() as Record<string, unknown>;
    (daysBy[String(data.restaurantId)] ??= []).push(adDayOf(data, String(data.day)));
  }
  const spentBy: Record<string, number> = {};
  const periodStart = istDayStart(since);
  for (const doc of bookings.docs) {
    const data = doc.data() as {restaurantId?: string; status?: string; pricePaise?: number; startAt?: number; endAt?: number; days?: number};
    if (!data.restaurantId || data.status === "cancelled") continue;
    const days = Math.max(1, Number(data.days) || 1);
    const overlap = Math.max(0, Math.min(now, Number(data.endAt)) - Math.max(periodStart, Number(data.startAt))) / DAY_MS;
    spentBy[data.restaurantId] = (spentBy[data.restaurantId] ?? 0) + (Number(data.pricePaise) || 0) / 100 * Math.min(1, overlap / days);
  }
  const stores = [...new Set([...Object.keys(daysBy), ...Object.keys(spentBy)])].map((rid) => ({
    restaurantId: rid, name: String(names.get(rid)?.name ?? rid), city: String(names.get(rid)?.city ?? ""),
    ...summarizeAdDays(daysBy[rid] ?? [], Math.round((spentBy[rid] ?? 0) * 100) / 100),
  })).sort((a, b) => b.earned - a.earned);
  const brandTitles = new Map(brandAds.docs.map((doc) => [doc.id, doc.data() as {title?: string; audience?: string[]; city?: string}]));
  const brandBy: Record<string, AdDay[]> = {};
  for (const doc of brandStats.docs) {
    const data = doc.data() as Record<string, unknown>;
    (brandBy[String(data.adId)] ??= []).push(adDayOf(data, String(data.day)));
  }
  const brands = Object.entries(brandBy).map(([adId, days]) => {
    const summary = summarizeAdDays(days, 0);
    const meta = brandTitles.get(adId);
    return {adId, title: String(meta?.title ?? adId), audience: Array.isArray(meta?.audience) ? meta.audience : [],
      impressions: summary.impressions, reach: summary.reach, clicks: summary.clicks, ctr: summary.ctr, avgViewSeconds: summary.avgViewSeconds};
  }).sort((a, b) => b.impressions - a.impressions);
  const total = summarizeAdDays(Object.values(daysBy).flat(), Object.values(spentBy).reduce((a, b) => a + b, 0));
  const csv = ["Store,City,Spent (Rs),Impressions,Reach,Taps,CTR %,Orders,Earned (Rs),Return (x)",
    ...stores.map((s) => [s.name, s.city, s.spent, s.impressions, s.reach, s.clicks, (s.ctr * 100).toFixed(2), s.orders, s.earned, s.roas]
      .map((v) => `"${String(v).replace(/"/g, "\"\"")}"`).join(","))].join("\n");
  return {since, days: input.days, total, stores, brands, csv};
}

/** Lets staff run the night's training now (after a deploy, or to refresh the report). */
export async function runLearningNow(token: DecodedIdToken): Promise<TrainingSummary> {
  requireStaff(token);
  return trainAll();
}

function round1(value: number): number { return Math.round(value * 10) / 10; }
function round2(value: number): number { return Math.round(value * 100) / 100; }
