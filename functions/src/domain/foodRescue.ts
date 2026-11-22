import type {Address, GeoPoint, PricedOrderItem, PricingBreakdown, SavrivoOrder, StatusEvent} from "../types";
import {isAfterPickupStatus} from "./afterPickup";
import {cancelCause} from "./partnerCancelPay";
import {buildLifecycleMutation, deriveLifecycle, deriveLifecycleFromCanonicalState} from "./lifecycle";
import {haversineKm} from "./order";

/**
 * Cancel after pickup and Food Rescue (founder 21-22 Nov 2026, Zomato-style).
 *
 * When Scraveit's admin cancels an order the delivery partner is already carrying:
 * - the customer's side ("Customer cancelled after pickup", "Customer not reachable at door"):
 *   online orders are not refunded; cash orders turn cash on delivery off for that customer;
 * - "Delivery problem" (Scraveit's side): the customer gets everything back;
 * - either way the restaurant is paid as if delivered and the partner gets the full trip.
 *
 * A customer's cancel then becomes a Food Rescue: for 15 minutes, customers within 3 km of
 * the partner see the food at half price (+ the normal delivery fee, online payment only).
 * The partner waits where they are and delivers it; if nobody takes it the food is theirs.
 */
export const FOOD_RESCUE_COLLECTION = "foodRescues";
export const FOOD_RESCUE_GONE_MESSAGE = "Someone else took this food, or its time ran out.";
export const FOOD_RESCUE_WINDOW_MS = 15 * 60_000;
/**
 * How long one customer holds the offer while they pay. New claims stop this long before the
 * window ends, so the delivery partner never waits more than 15 minutes in all.
 */
export const FOOD_RESCUE_HOLD_MS = 3 * 60_000;
export const FOOD_RESCUE_RADIUS_KM = 3;
/** Half the food price. */
export const FOOD_RESCUE_PRICE_SHARE_BPS = 5_000;
/** The partner's last GPS fix must be this fresh to place the offer. */
export const FOOD_RESCUE_LOCATION_MAX_AGE_MS = 5 * 60_000;

/** Food that melts or spoils in 15 minutes isn't offered (Zomato leaves these out too). */
const MELTS = /\b(ice[\s-]?creams?|kulfis?|(milk)?[\s-]?shakes?|smoothies?|faloodas?|sundaes?|gelatos?|frozen|slush(es|y)?|thick ?shakes?)\b/i;

export type AfterPickupCause = "customer" | "scraveit";

export interface AfterPickupPlan {
  cause: AfterPickupCause;
  /** Online and paid, the customer's side: no refund, the money is settled as if delivered. */
  charged: boolean;
  /** The customer gets their money back (online, Scraveit's side). */
  refund: boolean;
  /** Scraveit pays the restaurant and the partner itself (cash orders, or a refund). */
  scraveitPays: boolean;
  /** Cash order on the customer's side: cash on delivery goes off for that customer. */
  blockCod: boolean;
}

type CancelFacts = Pick<SavrivoOrder, "status" | "statusBeforeTerminal" | "cancelledByRole" | "cancelReason" |
  "paymentMethod" | "paymentState">;

export function cancelledAfterPickup(order: Pick<SavrivoOrder, "status" | "statusBeforeTerminal">): boolean {
  return order.status === "Cancelled" && isAfterPickupStatus(order.statusBeforeTerminal);
}

/** What a cancel after pickup does with the money, or null for any other order. */
export function afterPickupPlan(order: CancelFacts): AfterPickupPlan | null {
  if (!cancelledAfterPickup(order)) return null;
  const cause: AfterPickupCause = cancelCause(order) === "customer" ? "customer" : "scraveit";
  const paidOnline = order.paymentMethod !== "cod" && order.paymentState === "paid";
  const charged = cause === "customer" && paidOnline;
  return {
    cause,
    charged,
    refund: paidOnline && !charged,
    scraveitPays: !charged,
    blockCod: cause === "customer" && order.paymentMethod === "cod",
  };
}

/** Online, paid and the customer's side: never refunded (services/payments.ts). */
export function chargedAfterPickup(order: CancelFacts): boolean {
  return afterPickupPlan(order)?.charged === true;
}

export function rescueMeltsItem(name: unknown): boolean {
  return typeof name === "string" && MELTS.test(name);
}

/** One unit as the customer saw it on the menu (GST-inclusive price when the store shows one). */
function shownUnitPaise(item: PricedOrderItem): number {
  if (item.free) return 0;
  const listed = Number(item.listPrice);
  const unit = Number.isFinite(listed) && listed > 0 ? listed :
    Number(item.price || 0) + Number(item.variantPrice || 0) + Number(item.addOnTotal || 0);
  return Math.max(0, Math.round(unit * 100));
}

export interface RescueItem {
  name: string;
  quantity: number;
  diet: string;
  /** What one unit costs in the rescue (half the menu price), in paise. */
  unitPaise: number;
  /** One unit at the menu price, in paise, for the struck-out "was" price. */
  menuUnitPaise: number;
  free?: true;
}

export function rescueItems(order: Pick<SavrivoOrder, "items">): RescueItem[] {
  return (order.items ?? []).filter((item) => Number(item.quantity) > 0).map((item) => {
    const menuUnitPaise = shownUnitPaise(item);
    const variant = String(item.variant ?? "").trim();
    return {
      name: `${String(item.name ?? "").trim()}${variant ? ` (${variant})` : ""}`.slice(0, 120),
      quantity: Math.max(1, Math.round(Number(item.quantity))),
      diet: String(item.diet ?? ""),
      unitPaise: Math.round(menuUnitPaise * FOOD_RESCUE_PRICE_SHARE_BPS / 10_000),
      menuUnitPaise,
      ...(item.free ? {free: true as const} : {}),
    };
  });
}

export function rescuePricePaise(items: RescueItem[]): {pricePaise: number; menuPaise: number} {
  return items.reduce((sum, item) => ({
    pricePaise: sum.pricePaise + item.unitPaise * item.quantity,
    menuPaise: sum.menuPaise + item.menuUnitPaise * item.quantity,
  }), {pricePaise: 0, menuPaise: 0});
}

/** Veg-only customers only see an offer whose every dish is veg. */
export function rescueIsVeg(items: RescueItem[]): boolean {
  return items.length > 0 && items.every((item) => /^veg/i.test(item.diet) && !/non/i.test(item.diet));
}

export type RescueSkipReason =
  | "not_after_pickup" | "not_customer_side" | "already_rescue" | "no_partner" | "self_delivery"
  | "shared_trip" | "not_food" | "melts" | "no_location" | "nothing_to_sell";

/** Whether this cancelled order becomes a Food Rescue offer. */
export function rescueEligibility(
  order: SavrivoOrder,
  options: {storeKind?: string; partnerPoint?: (GeoPoint & {updatedAt?: number}) | null; now: number},
): {ok: true} | {ok: false; reason: RescueSkipReason} {
  const plan = afterPickupPlan(order);
  if (!plan) return {ok: false, reason: "not_after_pickup"};
  if (plan.cause !== "customer") return {ok: false, reason: "not_customer_side"};
  if (order.foodRescue) return {ok: false, reason: "already_rescue"};
  if (!String(order.riderId ?? "").trim()) return {ok: false, reason: "no_partner"};
  if (order.selfDelivery === true) return {ok: false, reason: "self_delivery"};
  // The partner is still carrying other customers' food: that trip goes on as planned.
  if ((order.batch?.orderIds.length ?? 0) > 1 || (order.clusterTrip?.orderIds.length ?? 0) > 1) {
    return {ok: false, reason: "shared_trip"};
  }
  const kind = String(options.storeKind ?? "restaurant").toLowerCase();
  if (kind && kind !== "restaurant") return {ok: false, reason: "not_food"};
  if ((order.items ?? []).some((item) => rescueMeltsItem(item.name) || rescueMeltsItem(item.variant))) {
    return {ok: false, reason: "melts"};
  }
  const point = options.partnerPoint;
  const fresh = point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)) &&
    !(Number(point.lat) === 0 && Number(point.lng) === 0) &&
    (!point.updatedAt || options.now - Number(point.updatedAt) <= FOOD_RESCUE_LOCATION_MAX_AGE_MS);
  if (!fresh) return {ok: false, reason: "no_location"};
  if (rescuePricePaise(rescueItems(order)).pricePaise <= 0) return {ok: false, reason: "nothing_to_sell"};
  return {ok: true};
}

export type FoodRescueStatus = "open" | "held" | "claimed" | "expired";

/** foodRescues/{original order id}: server-only (the partner's exact spot and the first customer stay private). */
export interface FoodRescueOffer {
  id: string;
  orderId: string;
  status: FoodRescueStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  restaurantId: string;
  restaurantName: string;
  items: RescueItem[];
  vegOnly: boolean;
  pricePaise: number;
  menuPaise: number;
  riderId: string;
  riderName: string;
  point: GeoPoint;
  city: string;
  cancelledCustomerId: string;
  testOrder: boolean;
  heldBy?: string;
  holdUntil?: number;
  claimOrderId?: string;
  claimedAt?: number;
  endedAt?: number;
}

export function buildRescueOffer(order: SavrivoOrder, point: GeoPoint, now: number): FoodRescueOffer {
  const items = rescueItems(order);
  const {pricePaise, menuPaise} = rescuePricePaise(items);
  return {
    id: order.id,
    orderId: order.id,
    status: "open",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + FOOD_RESCUE_WINDOW_MS,
    restaurantId: order.restaurantId,
    restaurantName: order.restaurant,
    items,
    vegOnly: rescueIsVeg(items),
    pricePaise,
    menuPaise,
    riderId: String(order.riderId),
    riderName: String(order.riderName ?? ""),
    point: {lat: Number(point.lat), lng: Number(point.lng)},
    city: String(order.address?.city ?? ""),
    cancelledCustomerId: order.customerId,
    testOrder: order.testOrder === true,
  };
}

/** The last moment a new customer can take the offer (a claim then has the full hold to pay). */
export function rescueClaimUntil(offer: Pick<FoodRescueOffer, "expiresAt">): number {
  return offer.expiresAt - FOOD_RESCUE_HOLD_MS;
}

/** Still for sale to this customer: open, or held by them while they pay. */
export function rescueOpenFor(offer: FoodRescueOffer, uid: string, now: number): boolean {
  if (offer.cancelledCustomerId === uid) return false;
  if (offer.status === "open") return now < rescueClaimUntil(offer);
  if (offer.status === "held") return offer.heldBy === uid && Number(offer.holdUntil) > now;
  return false;
}

/** The partner is still waiting with this food: open (and not past its window) or held by a payer. */
export function rescueHoldsPartner(offer: Pick<FoodRescueOffer, "status" | "expiresAt" | "holdUntil">, now: number): boolean {
  if (offer.status === "open") return now < offer.expiresAt;
  if (offer.status === "held") return Number(offer.holdUntil) > now;
  return false;
}

/** What a nearby customer's app gets: no partner name, no exact spot, nobody else's details. */
export interface PublicFoodRescue {
  id: string;
  restaurantName: string;
  items: Array<{name: string; quantity: number; veg: boolean}>;
  vegOnly: boolean;
  pricePaise: number;
  menuPaise: number;
  /** Until when this customer can take it (or, held by them, until when they can pay). */
  expiresAt: number;
  distanceKm: number;
  heldByYou: boolean;
  claimOrderId?: string;
}

export function publicRescue(offer: FoodRescueOffer, viewer: GeoPoint, uid: string): PublicFoodRescue {
  const heldByYou = offer.status === "held" && offer.heldBy === uid;
  return {
    id: offer.id,
    restaurantName: offer.restaurantName,
    items: offer.items.map((item) => ({name: item.name, quantity: item.quantity, veg: /^veg/i.test(item.diet) && !/non/i.test(item.diet)})),
    vegOnly: offer.vegOnly,
    pricePaise: offer.pricePaise,
    menuPaise: offer.menuPaise,
    expiresAt: heldByYou ? Number(offer.holdUntil) : rescueClaimUntil(offer),
    distanceKm: Math.round(haversineKm(offer.point, viewer) * 10) / 10,
    heldByYou,
    ...(heldByYou && offer.claimOrderId ? {claimOrderId: offer.claimOrderId} : {}),
  };
}

/** Offers this customer may see at this spot: within 3 km, not their own cancel, testers see test food only. */
export function nearbyRescues(
  offers: FoodRescueOffer[],
  viewer: GeoPoint,
  uid: string,
  now: number,
  tester: boolean,
): PublicFoodRescue[] {
  return offers
    .filter((offer) => rescueOpenFor(offer, uid, now) && offer.testOrder === tester &&
      haversineKm(offer.point, viewer) <= FOOD_RESCUE_RADIUS_KM)
    .map((offer) => publicRescue(offer, viewer, uid))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 3);
}

/** Minutes for the partner to ride over: a quick ride, never under 10 minutes. */
export function rescueEtaMinutes(roadKm: number): {etaMin: number; etaMax: number} {
  const ride = Math.max(1, Math.round(Math.max(0, roadKm) * 3));
  const etaMin = Math.max(10, ride + 5);
  return {etaMin, etaMax: etaMin + 10};
}

/** The new order a customer is buying (unpaid until Cashfree confirms). */
export function buildRescueOrder(input: {
  orderId: string;
  idempotencyKey: string;
  schemaVersion: number;
  offer: FoodRescueOffer;
  customer: {uid: string; name: string};
  address: Address;
  deliveryFee: number;
  distanceKm: number;
  roadKm: number | null;
  paymentMethod: "upi" | "card";
  paymentProvider?: string;
  now: number;
  eventId: string;
}): SavrivoOrder {
  const {offer, now} = input;
  const items: PricedOrderItem[] = offer.items.map((item, index) => ({
    itemId: `rescue_${index + 1}`,
    name: item.name,
    quantity: item.quantity,
    price: item.unitPaise / 100,
    variant: "",
    variantPrice: 0,
    addOns: [],
    addOnTotal: 0,
    note: "Food Rescue",
    diet: item.diet,
    ...(item.free ? {free: true as const} : {}),
  }));
  const subtotal = offer.pricePaise / 100;
  const deliveryFee = Math.round(Math.max(0, input.deliveryFee) * 100) / 100;
  const total = Math.round((subtotal + deliveryFee) * 100) / 100;
  const pricing: PricingBreakdown = {
    subtotal,
    discount: 0,
    deliveryFee,
    smallOrderFee: 0,
    lateNightFee: 0,
    rainFee: 0,
    surgeFee: 0,
    riderIncentiveFee: 0,
    platformFee: 0,
    tax: 0,
    tip: 0,
    currency: "INR",
    source: "catalog_snapshot_v3",
  };
  const eta = rescueEtaMinutes(input.roadKm ?? input.distanceKm);
  const event: StatusEvent = {status: "Order placed", at: now, actorId: input.customer.uid, actorRole: "customer"};
  const base: SavrivoOrder = {
    id: input.orderId,
    schemaVersion: input.schemaVersion,
    idempotencyKey: input.idempotencyKey,
    customerId: input.customer.uid,
    customerName: (input.customer.name.trim() || "Scraveit customer").slice(0, 120),
    customerPhone: input.address.phone,
    restaurantId: offer.restaurantId,
    restaurant: offer.restaurantName,
    // The food is with the delivery partner: the trip starts where they wait.
    restaurantLocation: {address: `Food Rescue · ${offer.restaurantName}`.slice(0, 200), lat: offer.point.lat, lng: offer.point.lng},
    items,
    pricing,
    pricingContext: {
      distanceKm: Math.round(input.distanceKm * 100) / 100,
      ...(input.roadKm != null ? {roadKm: input.roadKm} : {}),
      platformFeeRule: "food_rescue",
      weatherSeverity: "",
      surgeActiveOrders: 0,
      pricedAt: now,
    },
    total,
    coupon: "",
    paymentMethod: input.paymentMethod,
    ...(input.paymentProvider ? {paymentProvider: input.paymentProvider} : {}),
    paymentState: "pending",
    deliveryMode: "asap",
    address: input.address,
    instructions: "",
    contactless: false,
    status: "Order placed",
    statusHistory: {[input.eventId]: event},
    createdAt: now,
    updatedAt: now,
    etaMin: eta.etaMin,
    etaMax: eta.etaMax,
    foodRescue: {
      fromOrderId: offer.orderId,
      offerExpiresAt: offer.expiresAt,
      menuPaise: offer.menuPaise,
      foodPaise: offer.pricePaise,
    },
    ...(offer.testOrder ? {testOrder: true} : {}),
  };
  return {...base, ...deriveLifecycleFromCanonicalState(base)};
}

/**
 * Paid: the partner who has the food starts the delivery at once. The order skips the
 * restaurant steps (they happened on the cancelled order) and goes to "Out for delivery".
 */
export function buildRescueStartCandidate(
  current: SavrivoOrder,
  offer: Pick<FoodRescueOffer, "riderId" | "riderName">,
  now: number,
  eventId: string,
): SavrivoOrder | undefined {
  if (!current.foodRescue || current.status !== "Order placed" || current.paymentState !== "paid" || current.riderId) return undefined;
  const event: StatusEvent = {
    status: "Out for delivery",
    at: now,
    actorId: "system:food-rescue",
    actorRole: "system",
    detail: "Food Rescue: the delivery partner already has the food",
  };
  const candidate: SavrivoOrder = {
    ...current,
    status: "Out for delivery",
    riderId: offer.riderId,
    ...(offer.riderName ? {riderName: offer.riderName} : {}),
    riderAssignedAt: now,
    updatedAt: now,
    statusHistory: {...(current.statusHistory ?? {}), [eventId]: event},
  };
  // Forward skips only: the restaurant and pickup steps happened on the cancelled order.
  const lifecycle = buildLifecycleMutation(deriveLifecycle(current), deriveLifecycleFromCanonicalState(candidate), now,
    {allowSkips: true});
  return {...candidate, ...lifecycle.patch};
}
