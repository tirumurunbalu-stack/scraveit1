/**
 * Food Rescue, server side (rules in domain/foodRescue.ts; founder 22 Nov 2026).
 *
 * 1. Scraveit's admin cancels an order after pickup on the customer's side → startFoodRescue
 *    saves foodRescues/{order id} where the delivery partner is, and customers within 3 km hear
 *    about it (one push each).
 * 2. A customer taps it → claimFoodRescue (through createOrder) makes a new unpaid order from
 *    the partner's spot and holds the food for them for 3 minutes while they pay online.
 * 3. Paid → startFoodRescueDelivery: the same partner gets the drop straight away
 *    ("Out for delivery"). Not paid in time, or closed → releaseFoodRescueHold puts it back.
 * 4. Nobody bought it in 15 minutes → the partner keeps the food and gets orders again.
 * The foodRescueTimer task (index.ts) runs the hold and window ends and the nearby alerts.
 */
import {getFunctions} from "firebase-admin/functions";
import {logger} from "firebase-functions";
import {db, firestoreDb} from "../admin";
import {REGION, ROOT, SCHEMA_VERSION} from "../config";
import {
  FOOD_RESCUE_COLLECTION,
  FOOD_RESCUE_GONE_MESSAGE,
  FOOD_RESCUE_HOLD_MS,
  FOOD_RESCUE_RADIUS_KM,
  afterPickupPlan,
  buildRescueOffer,
  buildRescueOrder,
  buildRescueStartCandidate,
  nearbyRescues,
  rescueClaimUntil,
  rescueEligibility,
  rescueEtaMinutes,
  rescueHoldsPartner,
  rescueOpenFor,
  type FoodRescueOffer,
  type PublicFoodRescue,
  type RescueSkipReason,
} from "../domain/foodRescue";
import {haversineKm} from "../domain/order";
import {stripPrivateOrderFields} from "../domain/orderSecurity";
import {storeTypeOf} from "../domain/restaurantOnboarding";
import {DomainError} from "../errors";
import {orderRef, restaurantRef} from "../firestorePaths";
import {FieldValue, type DocumentReferenceLike, type TransactionLike} from "../firestoreTypes";
import type {Address, SavrivoOrder} from "../types";
import {assertMayOrder} from "./accountAge";
import {loadCustomerAddress, rescueDeliveryFee} from "./catalog";
import {forgetFoodRescueHolders} from "./foodRescueHolds";
import {notifyCustomerFoodRescue, notifyPartnerFoodRescue} from "./notifications";
import {
  cancelOrderAsSystem,
  cancelUnpaidOnlineOrder,
  claimOrderId,
  eventKey,
  onlinePaymentFor,
  reserveDeliveryOtp,
} from "./orders";
import {assertMayPlaceOrder, isTestCustomer, testCustomerUids} from "./testAccounts";

/** At most this many nearby customers hear about one offer (nearest first). */
const MAX_ALERTS = 200;
/** A shown total is honoured at the tap for this long (shown total = charged total). */
const QUOTE_MS = 10 * 60_000;
const QUOTES = "foodRescueQuotes";

export type FoodRescueTimerKind = "announce" | "hold" | "expire";

export function foodRescueRef(id: string): DocumentReferenceLike {
  return firestoreDb.collection(FOOD_RESCUE_COLLECTION).doc(id);
}

function rupees(paise: number): string {
  const value = Math.max(0, Math.round(paise)) / 100;
  return `₹${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pointOf(offer: FoodRescueOffer): {id: string; lat: number; lng: number; city: string} {
  return {id: `rescue_${offer.id}`, lat: offer.point.lat, lng: offer.point.lng, city: offer.city};
}

function dishLine(offer: Pick<FoodRescueOffer, "items">): string {
  const first = offer.items[0];
  if (!first) return "Food";
  const more = offer.items.length - 1;
  return `${first.quantity > 1 ? `${first.quantity} × ` : ""}${first.name}${more > 0 ? ` + ${more} more` : ""}`;
}

export async function scheduleFoodRescueTimer(offerId: string, at: number, kind: FoodRescueTimerKind): Promise<void> {
  const delaySeconds = Math.max(0, Math.ceil((at - Date.now()) / 1000) + (kind === "announce" ? 0 : 1));
  await getFunctions().taskQueue(`locations/${REGION}/functions/foodRescueTimer`).enqueue(
    {offerId, kind},
    {scheduleDelaySeconds: delaySeconds},
  );
}

/* ------------------------------------------------------------------ start */

/**
 * The cancelled order becomes an offer when it can (domain/foodRescue.ts rescueEligibility).
 * Safe to run again on a retried trigger: the offer is made once; the timer and the alerts
 * are re-queued while it is still open (both are no-ops the second time).
 */
export async function startFoodRescue(order: SavrivoOrder): Promise<{started: boolean; reason?: RescueSkipReason}> {
  const plan = afterPickupPlan(order);
  if (!plan) return {started: false, reason: "not_after_pickup"};
  if (plan.cause !== "customer") return {started: false, reason: "not_customer_side"};
  const ref = foodRescueRef(order.id);
  const existing = await ref.get();
  if (existing.exists) {
    const offer = existing.data() as FoodRescueOffer;
    if (offer.status === "open" && rescueHoldsPartner(offer, Date.now())) await queueTimers(offer);
    return {started: true};
  }
  const riderId = String(order.riderId ?? "");
  const [restaurantSnapshot, presenceSnapshot] = await Promise.all([
    restaurantRef(firestoreDb, order.restaurantId).get().catch(() => null),
    riderId ? db.ref(`${ROOT}/riderPresence/${riderId}`).get().catch(() => null) : Promise.resolve(null),
  ]);
  const restaurant = restaurantSnapshot?.exists ? restaurantSnapshot.data() as {storeType?: unknown} : {};
  const presence = (presenceSnapshot?.val() ?? null) as {lat?: unknown; lng?: unknown; updatedAt?: unknown} | null;
  const now = Date.now();
  const partnerPoint = presence ? {
    lat: Number(presence.lat),
    lng: Number(presence.lng),
    ...(Number(presence.updatedAt) > 0 ? {updatedAt: Number(presence.updatedAt)} : {}),
  } : null;
  const eligibility = rescueEligibility(order, {storeKind: storeTypeOf(restaurant.storeType), partnerPoint, now});
  if (!eligibility.ok) {
    logger.info("FOOD_RESCUE_SKIPPED", {orderId: order.id, reason: eligibility.reason});
    return {started: false, reason: eligibility.reason};
  }
  const candidate = buildRescueOffer(order, partnerPoint!, now);
  const offer = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) return snapshot.data() as FoodRescueOffer;
    transaction.set(ref, candidate);
    return candidate;
  });
  forgetFoodRescueHolders();
  logger.info("FOOD_RESCUE_STARTED", {orderId: order.id, riderId, pricePaise: offer.pricePaise, items: offer.items.length});
  await queueTimers(offer);
  return {started: true};
}

async function queueTimers(offer: FoodRescueOffer): Promise<void> {
  await Promise.all([
    scheduleFoodRescueTimer(offer.id, Date.now(), "announce"),
    scheduleFoodRescueTimer(offer.id, offer.expiresAt, "expire"),
  ]).catch((error) => logger.error("FOOD_RESCUE_TIMER_QUEUE_FAILED", {offerId: offer.id, error: String(error)}));
}

/* ----------------------------------------------------------------- alerts */

interface AlertProfile {
  addresses?: Array<{id?: unknown; lat?: unknown; lng?: unknown}>;
  selectedAddressId?: unknown;
  preferences?: {notifications?: unknown; vegetarian?: unknown};
}

/** Customers whose current address is within 3 km of the partner (same pick as a city broadcast). */
export function rescueAudience(
  offer: Pick<FoodRescueOffer, "point" | "cancelledCustomerId" | "riderId" | "testOrder" | "vegOnly">,
  profiles: Array<{uid: string; profile: AlertProfile}>,
  testers: ReadonlySet<string>,
): Array<{uid: string; km: number}> {
  const found: Array<{uid: string; km: number}> = [];
  for (const {uid, profile} of profiles) {
    if (!uid || uid === offer.cancelledCustomerId || uid === offer.riderId) continue;
    if (testers.has(uid) !== offer.testOrder) continue;
    if (profile?.preferences?.notifications === false) continue;
    if (profile?.preferences?.vegetarian === true && !offer.vegOnly) continue;
    const addresses = Array.isArray(profile?.addresses) ? profile.addresses : [];
    const current = addresses.find((entry) => entry?.id === profile.selectedAddressId) ?? addresses[0];
    const lat = Number(current?.lat);
    const lng = Number(current?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
    const km = haversineKm(offer.point, {lat, lng});
    if (km <= FOOD_RESCUE_RADIUS_KM) found.push({uid, km});
  }
  return found.sort((a, b) => a.km - b.km).slice(0, MAX_ALERTS);
}

export function rescueAlertCopy(offer: Pick<FoodRescueOffer, "items" | "restaurantName" | "pricePaise" | "expiresAt">,
  km: number, now: number): {title: string; body: string} {
  const minutes = Math.max(1, Math.round((rescueClaimUntil(offer) - now) / 60_000));
  return {
    title: "Food Rescue near you: half price",
    body: `${dishLine(offer)} from ${offer.restaurantName}, ${Math.max(0.1, Math.round(km * 10) / 10)} km away. ` +
      `${rupees(offer.pricePaise)} + delivery. Ready now, only for ${minutes} min.`,
  };
}

async function alertNearbyCustomers(offer: FoodRescueOffer): Promise<number> {
  const now = Date.now();
  if (offer.status !== "open" || now >= rescueClaimUntil(offer)) return 0;
  const [snapshot, testers] = await Promise.all([
    firestoreDb.collection("users").select("addresses", "selectedAddressId", "preferences").get(),
    testCustomerUids().catch(() => new Set<string>()),
  ]);
  const people = rescueAudience(offer, snapshot.docs.map((doc) => ({uid: doc.id, profile: doc.data() as AlertProfile})), testers);
  for (let index = 0; index < people.length; index += 20) {
    await Promise.all(people.slice(index, index + 20).map((person) => notifyCustomerFoodRescue({
      uid: person.uid,
      rescueId: offer.id,
      ...rescueAlertCopy(offer, person.km, now),
      endsAt: rescueClaimUntil(offer),
    }).catch((error) => logger.warn("FOOD_RESCUE_ALERT_FAILED", {offerId: offer.id, uid: person.uid, error: String(error)}))));
  }
  logger.info("FOOD_RESCUE_ALERTS_SENT", {offerId: offer.id, customers: people.length});
  return people.length;
}

/* ---------------------------------------------------------------- listing */

export interface FoodRescueListing extends PublicFoodRescue {
  deliveryFee: number;
  total: number;
  etaMin: number;
  etaMax: number;
}

function quoteRef(uid: string, offerId: string, addressId: string): DocumentReferenceLike {
  return firestoreDb.collection(QUOTES).doc(`${uid}_${offerId}_${addressId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 400));
}

async function openOffers(): Promise<FoodRescueOffer[]> {
  const snapshot = await firestoreDb.collection(FOOD_RESCUE_COLLECTION).where("status", "in", ["open", "held"]).limit(50).get();
  return snapshot.docs.map((doc) => doc.data() as FoodRescueOffer);
}

/** What this customer's home screen shows for their selected address (nearest 3, priced to the rupee). */
export async function foodRescuesForCustomer(uid: string, addressId: string): Promise<FoodRescueListing[]> {
  const now = Date.now();
  const offers = (await openOffers()).filter((offer) => rescueOpenFor(offer, uid, now));
  if (!offers.length) return [];
  let address: Address;
  let profile: Record<string, unknown>;
  try {
    ({address, profile} = await loadCustomerAddress(uid, addressId));
  } catch {
    return [];
  }
  const tester = await isTestCustomer(uid).catch(() => false);
  const vegOnly = (profile.preferences as {vegetarian?: unknown} | undefined)?.vegetarian === true;
  const shown = nearbyRescues(offers.filter((offer) => !vegOnly || offer.vegOnly), address, uid, now, tester);
  return Promise.all(shown.map(async (rescue) => {
    const offer = offers.find((entry) => entry.id === rescue.id)!;
    const fee = await rescueDeliveryFee(pointOf(offer), address);
    const total = round2(offer.pricePaise / 100 + fee.deliveryFee);
    await quoteRef(uid, offer.id, addressId).set({uid, offerId: offer.id, addressId, deliveryFee: fee.deliveryFee,
      distanceKm: fee.distanceKm, roadKm: fee.roadKm, total, at: now}).catch(() => undefined);
    return {...rescue, deliveryFee: fee.deliveryFee, total, ...rescueEtaMinutes(fee.roadKm ?? fee.distanceKm)};
  }));
}

/* ------------------------------------------------------------------ claim */

export interface FoodRescueClaimInput {
  foodRescueId: string;
  addressId: string;
  idempotencyKey: string;
  paymentMethod: "upi" | "card";
  paymentProvider?: string;
  quotedTotal?: number;
}

/**
 * A customer takes the food: a new order from the partner's spot to their address, unpaid until
 * Cashfree confirms (the app then opens the payment exactly as for any online order).
 */
export async function claimFoodRescue(uid: string, input: FoodRescueClaimInput): Promise<{
  order: SavrivoOrder; deliveryOtp: string; recovered: boolean;
}> {
  const {orderId, existing} = await claimOrderId(uid, input.idempotencyKey);
  if (existing) return recoveredClaim(existing);
  const ref = foodRescueRef(input.foodRescueId);
  const snapshot = await ref.get();
  const offer = snapshot.exists ? snapshot.data() as FoodRescueOffer : null;
  const now = Date.now();
  if (!offer || !rescueOpenFor(offer, uid, now)) throw new DomainError("failed-precondition", FOOD_RESCUE_GONE_MESSAGE);
  // Already paying for it (the app was closed mid-payment): the same order comes back.
  if (offer.status === "held" && offer.heldBy === uid && offer.claimOrderId) {
    const held = await orderRef(firestoreDb, offer.claimOrderId).get();
    const heldOrder = held.exists ? held.data() as SavrivoOrder : null;
    if (heldOrder && heldOrder.customerId === uid && heldOrder.status === "Order placed") return recoveredClaim(heldOrder);
    throw new DomainError("failed-precondition", FOOD_RESCUE_GONE_MESSAGE);
  }
  const [{testOrder}] = await Promise.all([assertMayPlaceOrder(uid, offer.restaurantId), assertMayOrder(uid)]);
  if (testOrder !== offer.testOrder) throw new DomainError("failed-precondition", FOOD_RESCUE_GONE_MESSAGE);
  const {address, profile} = await loadCustomerAddress(uid, input.addressId);
  const distanceKm = haversineKm(offer.point, address);
  if (distanceKm > FOOD_RESCUE_RADIUS_KM) {
    throw new DomainError("out-of-range", "This food is only for addresses within 3 km of it. Pick a nearer address.");
  }
  const payment = await onlinePaymentFor(input.paymentMethod, input.paymentProvider, now);
  const quoteSnapshot = await quoteRef(uid, offer.id, input.addressId).get().catch(() => null);
  const quote = quoteSnapshot?.exists ? quoteSnapshot.data() as {deliveryFee?: unknown; distanceKm?: unknown; roadKm?: unknown; at?: unknown} : null;
  const fee = quote && now - Number(quote.at) < QUOTE_MS && Number.isFinite(Number(quote.deliveryFee)) ? {
    deliveryFee: Number(quote.deliveryFee),
    distanceKm: Number(quote.distanceKm) || distanceKm,
    roadKm: quote.roadKm == null ? null : Number(quote.roadKm),
  } : await rescueDeliveryFee(pointOf(offer), address);
  const total = round2(offer.pricePaise / 100 + fee.deliveryFee);
  if (input.quotedTotal !== undefined && Math.round(input.quotedTotal * 100) !== Math.round(total * 100)) {
    throw new DomainError("failed-precondition", `The delivery fee changed. The new total is ${rupees(total * 100)}.`);
  }
  // Reserved before the order exists, like any order (services/orders.ts).
  const otp = await reserveDeliveryOtp(uid, orderId);
  const order = buildRescueOrder({
    orderId,
    idempotencyKey: input.idempotencyKey,
    schemaVersion: SCHEMA_VERSION,
    offer,
    customer: {uid, name: String(profile.name ?? "")},
    address,
    deliveryFee: fee.deliveryFee,
    distanceKm: fee.distanceKm,
    roadKm: fee.roadKm,
    paymentMethod: payment.paymentMethod,
    ...(payment.paymentProvider ? {paymentProvider: payment.paymentProvider} : {}),
    now,
    eventId: eventKey(now, uid),
  });
  const result = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const target = orderRef(firestoreDb, orderId);
    const [offerSnapshot, orderSnapshot] = [await transaction.get(ref), await transaction.get(target)];
    if (orderSnapshot.exists) return {created: false as const, order: orderSnapshot.data() as SavrivoOrder};
    const current = offerSnapshot.exists ? offerSnapshot.data() as FoodRescueOffer : null;
    const at = Date.now();
    if (!current || current.status !== "open" || !rescueOpenFor(current, uid, at)) {
      throw new DomainError("failed-precondition", FOOD_RESCUE_GONE_MESSAGE);
    }
    const holdUntil = Math.min(at + FOOD_RESCUE_HOLD_MS, current.expiresAt);
    transaction.set(target, order);
    transaction.set(ref, {status: "held", heldBy: uid, holdUntil, claimOrderId: orderId, updatedAt: at}, {merge: true});
    return {created: true as const, order, holdUntil};
  });
  if (!result.created) {
    if (result.order.customerId !== uid || result.order.idempotencyKey !== input.idempotencyKey) {
      throw new DomainError("aborted", "Another order operation won the transaction.");
    }
    return recoveredClaim(result.order);
  }
  await firestoreDb.collection("orderIdempotency").doc(`${uid}_${input.idempotencyKey}`).set({orderId, createdAt: now});
  await scheduleFoodRescueTimer(offer.id, result.holdUntil, "hold")
    .catch((error) => logger.error("FOOD_RESCUE_HOLD_TIMER_FAILED", {offerId: offer.id, orderId, error: String(error)}));
  logger.info("FOOD_RESCUE_CLAIMED", {offerId: offer.id, orderId, total});
  return {order: stripPrivateOrderFields(order), deliveryOtp: String(otp.otp ?? ""), recovered: false};
}

async function recoveredClaim(order: SavrivoOrder): Promise<{order: SavrivoOrder; deliveryOtp: string; recovered: boolean}> {
  const live = !["Delivered", "Cancelled"].includes(order.status);
  const deliveryOtp = live ? String((await reserveDeliveryOtp(order.customerId, order.id)).otp ?? "") : "";
  return {order: stripPrivateOrderFields(order), deliveryOtp, recovered: true};
}

/* ------------------------------------------------------------------ paid */

/**
 * The buyer's payment is verified: the partner who has the food delivers it now. If the offer
 * ended first (very late payment), the order is cancelled and the refund trigger pays it back.
 */
export async function startFoodRescueDelivery(order: SavrivoOrder): Promise<"started" | "ended" | "skipped"> {
  if (!order.foodRescue || order.status !== "Order placed" || order.paymentState !== "paid") return "skipped";
  const offerRef = foodRescueRef(order.foodRescue.fromOrderId);
  const target = orderRef(firestoreDb, order.id);
  const now = Date.now();
  const eventId = eventKey(now, "system:food-rescue");
  const result = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const [offerSnapshot, orderSnapshot] = [await transaction.get(offerRef), await transaction.get(target)];
    const offer = offerSnapshot.exists ? offerSnapshot.data() as FoodRescueOffer : null;
    const current = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
    if (!current || current.status !== "Order placed" || current.riderId || current.paymentState !== "paid") {
      return {kind: "skipped" as const};
    }
    const mine = offer && offer.claimOrderId === current.id && offer.heldBy === current.customerId &&
      (offer.status === "held" || offer.status === "claimed");
    if (!mine) return {kind: "ended" as const, current};
    const candidate = buildRescueStartCandidate(current, offer, now, eventId);
    if (!candidate) return {kind: "skipped" as const};
    transaction.set(target, stripPrivateOrderFields(candidate));
    transaction.set(offerRef, {status: "claimed", claimedAt: now, updatedAt: now}, {merge: true});
    return {kind: "started" as const, order: candidate, offer};
  });
  if (result.kind === "ended") {
    await cancelOrderAsSystem(result.current, "system:food-rescue", "Food Rescue ended before the payment came through",
      "food rescue offer ended before payment");
    logger.warn("FOOD_RESCUE_PAID_AFTER_END", {orderId: order.id, offerId: order.foodRescue.fromOrderId});
    return "ended";
  }
  if (result.kind !== "started") return "skipped";
  forgetFoodRescueHolders();
  const riderId = String(result.order.riderId);
  // Same as an assignment (index.ts onOrderUpdated "Assigned"): the partner app tracks this order now.
  await Promise.all([
    db.ref(`${ROOT}/riderPresence/${riderId}/activeOrderId`).set(order.id),
    db.ref(`${ROOT}/trackingAssignments/${order.id}`).set({riderId, customerId: order.customerId, assignedAt: now}),
  ]);
  const km = Math.round(Number(order.pricingContext?.roadKm ?? order.pricingContext?.distanceKm ?? 0) * 10) / 10;
  await notifyPartnerFoodRescue({
    riderId,
    key: `drop:${order.id}`,
    orderId: order.id,
    restaurantId: order.restaurantId,
    status: "Out for delivery",
    title: "New drop: Food Rescue",
    body: `A customer${km > 0 ? ` ${km} km away` : " nearby"} bought the ${order.restaurant} food. Open the app to deliver it.`,
  }).catch((error) => logger.warn("FOOD_RESCUE_DROP_PUSH_FAILED", {orderId: order.id, error: String(error)}));
  logger.info("FOOD_RESCUE_DELIVERY_STARTED", {orderId: order.id, offerId: result.offer.id, riderId});
  return "started";
}

/* ------------------------------------------------------------------- ends */

/** An unpaid buy was closed or ran out of time: the food goes back on offer, or the window is over. */
export async function releaseFoodRescueHold(offerId: string, claimOrderId: string): Promise<"open" | "expired" | "skipped"> {
  const ref = foodRescueRef(offerId);
  const outcome = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const offer = snapshot.exists ? snapshot.data() as FoodRescueOffer : null;
    if (!offer || offer.status !== "held" || offer.claimOrderId !== claimOrderId) return {kind: "skipped" as const};
    const now = Date.now();
    if (now < rescueClaimUntil(offer)) {
      transaction.set(ref, {status: "open", heldBy: FieldValue.delete(), holdUntil: FieldValue.delete(),
        claimOrderId: FieldValue.delete(), updatedAt: now}, {merge: true});
      return {kind: "open" as const, offer};
    }
    transaction.set(ref, {status: "expired", endedAt: now, updatedAt: now}, {merge: true});
    return {kind: "expired" as const, offer};
  });
  if (outcome.kind === "skipped") return "skipped";
  forgetFoodRescueHolders();
  logger.info("FOOD_RESCUE_HOLD_RELEASED", {offerId, claimOrderId, outcome: outcome.kind});
  if (outcome.kind === "expired") await tellPartnerFoodIsTheirs(outcome.offer);
  return outcome.kind;
}

async function expireFoodRescue(offerId: string): Promise<boolean> {
  const ref = foodRescueRef(offerId);
  const ended = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const offer = snapshot.exists ? snapshot.data() as FoodRescueOffer : null;
    const now = Date.now();
    if (!offer || offer.status !== "open" || now < offer.expiresAt) return null;
    transaction.set(ref, {status: "expired", endedAt: now, updatedAt: now}, {merge: true});
    return offer;
  });
  if (!ended) return false;
  forgetFoodRescueHolders();
  logger.info("FOOD_RESCUE_EXPIRED", {offerId});
  await tellPartnerFoodIsTheirs(ended);
  return true;
}

async function tellPartnerFoodIsTheirs(offer: FoodRescueOffer): Promise<void> {
  await notifyPartnerFoodRescue({
    riderId: offer.riderId,
    key: `ended:${offer.id}`,
    orderId: offer.orderId,
    restaurantId: offer.restaurantId,
    status: "Cancelled",
    title: "The food is yours",
    body: `No one bought the ${offer.restaurantName} food. Keep it. You can take new orders now.`,
  }).catch((error) => logger.warn("FOOD_RESCUE_END_PUSH_FAILED", {offerId: offer.id, error: String(error)}));
}

/** The foodRescueTimer task (index.ts). Every step checks the saved offer first, so repeats are harmless. */
export async function handleFoodRescueTimer(
  offerId: string,
  kind: FoodRescueTimerKind,
  closePayments: (orderId: string) => Promise<void>,
): Promise<string> {
  const snapshot = await foodRescueRef(offerId).get();
  const offer = snapshot.exists ? snapshot.data() as FoodRescueOffer : null;
  if (!offer) return "missing";
  const now = Date.now();
  if (kind === "announce") return `alerted:${await alertNearbyCustomers(offer)}`;
  if (offer.status === "held") {
    if (Number(offer.holdUntil) > now) {
      await scheduleFoodRescueTimer(offer.id, Number(offer.holdUntil), "hold");
      return "hold_running";
    }
    const claimSnapshot = offer.claimOrderId ? await orderRef(firestoreDb, offer.claimOrderId).get() : null;
    const claim = claimSnapshot?.exists ? claimSnapshot.data() as SavrivoOrder : null;
    if (claim?.paymentState === "paid") {
      // Paid, but the drop never started (its trigger event was missed): start it now.
      if (claim.status === "Order placed" && !claim.riderId) return `paid:${await startFoodRescueDelivery(claim)}`;
      return "paid";
    }
    if (claim && claim.status === "Order placed") {
      try {
        await cancelUnpaidOnlineOrder(claim.customerId, claim.id, "Food Rescue payment was not finished in time", closePayments);
      } catch (error) {
        // The payment landed while we checked: startFoodRescueDelivery takes it from here.
        if (error instanceof DomainError && error.code === "already-exists") return "paid";
        throw error;
      }
    }
    return releaseFoodRescueHold(offer.id, String(offer.claimOrderId ?? ""));
  }
  if (offer.status === "open") {
    if (now < offer.expiresAt) {
      await scheduleFoodRescueTimer(offer.id, offer.expiresAt, "expire");
      return "open_running";
    }
    return (await expireFoodRescue(offer.id)) ? "expired" : "skipped";
  }
  return offer.status;
}
