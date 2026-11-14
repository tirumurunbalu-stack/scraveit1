import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {economicsScopeKey} from "../domain/economics";
import {
  calculateRiderTripPay,
  minuteOfDayInTimeZone,
  normalizeRiderTripPayOverride,
  DEFAULT_RIDER_TRIP_PAY_POLICY,
  type RiderTripPayBreakdown,
  type RiderTripPayPolicy,
} from "../domain/riderTripPay";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import {dispatchQueueRef, riderJobRef, riderRef} from "../firestorePaths";
import {riderOfferPayout, riderPayoutBreakdown} from "../domain/riderJob";
import type {SavrivoOrder, StatusEvent} from "../types";
import {loadEconomicsControl, orderEconomicsRef} from "./economics";
import type {DeliveryLedgerOptions, LedgerAttribution} from "./ledger";

/**
 * Everything a delivered order's journal needs beyond the frozen checkout
 * snapshot: the rider's final trip pay and where the money belongs.
 */
export async function resolveDeliverySettlementOptions(
  order: SavrivoOrder,
  database: FirestoreLike = firestoreDb,
): Promise<DeliveryLedgerOptions> {
  if (!order.economics) return {};
  const [finalTrip, attribution] = await Promise.all([
    finalizeRiderTripPay(order, database).catch((error) => {
      // The estimate frozen at checkout is still a valid, balanced settlement.
      logger.error("RIDER_TRIP_PAY_FINALIZE_FAILED", {orderId: order.id, error});
      return null;
    }),
    orderAttribution(order, database),
  ]);
  return {
    ...(finalTrip ? {finalTripPayPaise: finalTrip.totalPaise} : {}),
    attribution,
  };
}

export async function orderAttribution(order: SavrivoOrder, database: FirestoreLike = firestoreDb): Promise<LedgerAttribution> {
  const control = await loadEconomicsControl(Date.now(), database);
  const cityKey = order.economics?.cityKey ?? "";
  const city = control.cities[cityKey];
  return {
    countryKey: city?.countryKey ?? "",
    stateKey: city?.stateKey ?? "",
    cityKey,
    zoneKey: order.economics?.zoneKey ?? "",
    restaurantId: order.restaurantId,
    customerId: order.customerId,
    ...(order.riderId ? {riderId: order.riderId} : {}),
  };
}

/** Attribution for a rider-level entry (bonus, guarantee, referral): the rider's own city. */
export async function riderAttribution(
  riderId: string,
  riderProfile: Record<string, unknown> | null,
  database: FirestoreLike = firestoreDb,
): Promise<LedgerAttribution> {
  const profile: Record<string, unknown> = riderProfile ?? await riderRef(database, riderId).get().then((doc) =>
    ((doc.exists ? doc.data() : null) ?? {}) as Record<string, unknown>);
  const cityKey = economicsScopeKey(profile.city ?? profile.cityName ?? "");
  const control = await loadEconomicsControl(Date.now(), database);
  const city = control.cities[cityKey];
  return {
    countryKey: city?.countryKey ?? "",
    stateKey: city?.stateKey ?? "",
    cityKey,
    riderId,
  };
}

interface StoredFinalTrip extends RiderTripPayBreakdown {
  computedAt: number;
  pickupSource: string;
  waitSource: string;
}

function frozenPolicy(value: unknown): RiderTripPayPolicy {
  return {
    ...DEFAULT_RIDER_TRIP_PAY_POLICY,
    slotAddons: [],
    vehicleMultiplierBps: {},
    ...normalizeRiderTripPayOverride(value),
  };
}

const RIDER_HANDOVER_GRACE_MS = 2 * 60_000;

function firstEvent(order: SavrivoOrder, status: SavrivoOrder["status"]): StatusEvent | undefined {
  return Object.values(order.statusHistory ?? {}).filter((event) => event.status === status)
    .sort((a, b) => (Number(a.at) || Number.MAX_SAFE_INTEGER) - (Number(b.at) || Number.MAX_SAFE_INTEGER))[0];
}

/**
 * When waiting at the restaurant ended. A rider who records the pickup by
 * typing the code stops the clock no later than 2 minutes after the food was
 * marked ready, so typing the code late never adds waiting pay.
 */
export function handoverAt(order: SavrivoOrder): number {
  const handed = firstEvent(order, "Handed to rider");
  if (!handed) return 0;
  const at = Number(handed.at) || Number.MAX_SAFE_INTEGER;
  const readyAt = Number(firstEvent(order, "Ready for pickup")?.at) || 0;
  return handed.actorRole === "rider" && readyAt > 0 ? Math.min(at, readyAt + RIDER_HANDOVER_GRACE_MS) : at;
}

/**
 * Computes the rider's final trip pay once, from the policy frozen at
 * checkout, the real pickup distance (dispatch) and the real waiting time
 * (verified restaurant arrival to handover). The first result is stored and
 * every retry reuses it, so the immutable delivery journal never changes.
 */
export async function finalizeRiderTripPay(
  order: SavrivoOrder,
  database: FirestoreLike = firestoreDb,
): Promise<StoredFinalTrip | null> {
  if (!order.economics || !order.riderId) return null;
  const economicsRef = orderEconomicsRef(database, order.id);
  const existing = await economicsRef.get();
  const record = (existing.exists ? existing.data() : null) as Record<string, unknown> | null;
  if (!record) return null;
  if (record.riderFinal && typeof record.riderFinal === "object") return record.riderFinal as StoredFinalTrip;
  // No trip-pay formula was frozen at checkout (rider pay = the bill's delivery
  // fee): the fee stays, plus waiting pay that Scraveit pays (founder 2026-11-14:
  // the customer can't be charged for a kitchen delay after the price is locked).
  if (!record.tripPayPolicy || typeof record.tripPayPolicy !== "object") {
    return finalizeFeeTripWithWaiting(order, record, economicsRef, database);
  }
  const policy = frozenPolicy(record.tripPayPolicy);
  const estimate = order.economics.rider.tripPay;
  const [queue, arrival, rider] = await Promise.all([
    dispatchQueueRef(database, order.id).get(),
    database.collection("riderRestaurantArrivals").doc(order.id).get(),
    riderRef(database, order.riderId).get(),
  ]);
  const candidates = ((queue.exists ? queue.data() : {}) as {candidates?: Array<{riderId?: string; distanceKm?: number}>}).candidates ?? [];
  const candidate = candidates.find((entry) => entry.riderId === order.riderId);
  const pickupMeters = candidate && Number.isFinite(Number(candidate.distanceKm)) ?
    Math.round(Number(candidate.distanceKm) * 1_000) : policy.expectedPickupMeters;
  const arrivedAt = Number((arrival.exists ? arrival.data() as {arrivedAt?: unknown; riderId?: unknown} : {}).arrivedAt ?? 0);
  const arrivalRider = String((arrival.exists ? arrival.data() as {riderId?: unknown} : {}).riderId ?? "");
  const handedAt = handoverAt(order);
  const waitMinutes = arrivedAt > 0 && handedAt > arrivedAt && arrivalRider === order.riderId ?
    Math.floor((handedAt - arrivedAt) / 60_000) : 0;
  const vehicleType = String(((rider.exists ? rider.data() : {}) as {vehicleType?: unknown}).vehicleType ?? "");
  const deliveredAt = Number(order.deliveredAt ?? order.updatedAt) || Date.now();
  const breakdown = calculateRiderTripPay(policy, {
    pickupMeters,
    dropMeters: estimate?.dropMeters ?? Math.round(Number(order.pricingContext?.distanceKm ?? 0) * 1_000),
    waitMinutes,
    minuteOfDay: minuteOfDayInTimeZone(deliveredAt),
    vehicleType,
  });
  const final: StoredFinalTrip = {
    ...breakdown,
    computedAt: Date.now(),
    pickupSource: candidate ? "dispatch_gps_straight_line" : "policy_expected",
    waitSource: waitMinutes > 0 ? "verified_arrival_to_handover" : arrivedAt > 0 ? "no_wait" : "no_verified_arrival",
  };
  return database.runTransaction(async (transaction: TransactionLike) => {
    const current = await transaction.get(economicsRef);
    const stored = (current.exists ? current.data() : {}) as Record<string, unknown>;
    if (stored.riderFinal && typeof stored.riderFinal === "object") return stored.riderFinal as StoredFinalTrip;
    transaction.set(economicsRef, {riderFinal: final}, {merge: true});
    return final;
  });
}

/** Verified waiting at the restaurant, in whole minutes (0 when not verified). */
async function verifiedWaitMinutes(order: SavrivoOrder, database: FirestoreLike): Promise<{minutes: number; source: string}> {
  const arrival = await database.collection("riderRestaurantArrivals").doc(order.id).get();
  const data = (arrival.exists ? arrival.data() : {}) as {arrivedAt?: unknown; riderId?: unknown};
  const arrivedAt = Number(data.arrivedAt ?? 0);
  const handedAt = handoverAt(order);
  const minutes = arrivedAt > 0 && handedAt > arrivedAt && String(data.riderId ?? "") === order.riderId ?
    Math.floor((handedAt - arrivedAt) / 60_000) : 0;
  return {minutes, source: minutes > 0 ? "verified_arrival_to_handover" : arrivedAt > 0 ? "no_wait" : "no_verified_arrival"};
}

/** Waiting pay on fee-based trips: first 10 minutes free, then ₹1 a minute, at most ₹30. */
export function feeTripWaitingPaise(waitMinutes: number): number {
  const policy = DEFAULT_RIDER_TRIP_PAY_POLICY;
  return Math.min(policy.maxWaitPaise, Math.max(0, Math.floor(waitMinutes) - policy.freeWaitMinutes) * policy.waitPerMinutePaise);
}

/**
 * Trip pay = the bill's delivery fee (frozen at checkout) + waiting pay. Stored
 * once like the formula trips, so the delivery journal never changes on retry.
 * No waiting pay due = null: the frozen fee is final, exactly as before.
 */
async function finalizeFeeTripWithWaiting(
  order: SavrivoOrder,
  record: Record<string, unknown>,
  economicsRef: ReturnType<typeof orderEconomicsRef>,
  database: FirestoreLike,
): Promise<StoredFinalTrip | null> {
  if (record.feeTripWaitChecked === true) return null;
  const wait = await verifiedWaitMinutes(order, database);
  const waitingPaise = feeTripWaitingPaise(wait.minutes);
  const feePaise = Number(order.economics?.rider.deliveryPayPaise ?? 0) || 0;
  if (waitingPaise <= 0) {
    await economicsRef.set({feeTripWaitChecked: true}, {merge: true});
    return null;
  }
  const final: StoredFinalTrip = {
    basePickupPaise: feePaise,
    pickupDistancePaise: 0,
    dropDistancePaise: 0,
    longDistancePaise: 0,
    vehicleAdjustmentPaise: 0,
    minimumTopUpPaise: 0,
    maximumCapPaise: 0,
    waitingPaise,
    slotPaise: 0,
    slotLabels: [],
    totalPaise: feePaise + waitingPaise,
    pickupMeters: 0,
    dropMeters: 0,
    waitMinutes: wait.minutes,
    computedAt: Date.now(),
    pickupSource: "bill_delivery_fee",
    waitSource: wait.source,
  };
  const settled = await database.runTransaction(async (transaction: TransactionLike) => {
    const current = await transaction.get(economicsRef);
    const stored = (current.exists ? current.data() : {}) as Record<string, unknown>;
    if (stored.riderFinal && typeof stored.riderFinal === "object") return stored.riderFinal as StoredFinalTrip;
    transaction.set(economicsRef, {riderFinal: final}, {merge: true});
    return final;
  });
  // Show it on the delivery partner's trip: "Waiting pay ₹15" beside the trip pay.
  await riderJobRef(database, String(order.riderId), order.id).set({
    waitingPayPaise: settled.waitingPaise,
    waitMinutes: settled.waitMinutes,
    payout: riderOfferPayout(order, settled.waitingPaise),
    payoutBreakdown: riderPayoutBreakdown(order, settled.waitingPaise),
  }, {merge: true}).catch((error: unknown) => logger.warn("RIDER_JOB_WAIT_PAY_DISPLAY_FAILED", {orderId: order.id, error: String(error)}));
  return settled;
}
