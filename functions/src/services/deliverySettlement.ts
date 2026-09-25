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
import {dispatchQueueRef, riderRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";
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

function handoverAt(order: SavrivoOrder): number {
  const events = Object.values(order.statusHistory ?? {}).filter((event) => event.status === "Handed to rider");
  return events.length ? Math.min(...events.map((event) => Number(event.at) || Number.MAX_SAFE_INTEGER)) : 0;
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
