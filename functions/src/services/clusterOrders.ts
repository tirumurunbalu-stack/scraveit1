import {createHash} from "node:crypto";
import {FieldValue} from "firebase-admin/firestore";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {clusterPlanFeatures, DEFAULT_CLUSTER_POLICY, fallbackPrepMinutes, partTemperature, planClusterDelivery, statedPrepMinutes, type ClusterLegInput, type ClusterPlan} from "../domain/clusterPlan";
import {availabilityCityKey} from "../domain/dispatch";
import {rupeesToPaise} from "../domain/economics";
import {menuPricingOf} from "../domain/markupPricing";
import {priceCart} from "../domain/order";
import {DomainError} from "../errors";
import type {CatalogItem, CatalogRestaurant, ClusterTripLink, SavrivoOrder} from "../types";
import {loadCustomerAddress, loadRestaurantAndMenu, loadServerFees} from "./catalog";
import {learnedPlanInputs, nearestRiderMinutes} from "./learning";
import {createAuthoritativeOrder} from "./orders";

/**
 * Multi-restaurant ("cluster") orders: one cart with food from two or three restaurants,
 * paid as one. Each restaurant gets an ordinary order with only its own items, so nothing
 * changes for kitchens, tax or settlement. Here we:
 *
 *  - create every restaurant's part on hold (no restaurant sees it), then release them all
 *    together, so a failure halfway never leaves one kitchen cooking a broken cart;
 *  - charge the platform fee once and judge the small-order fee on the whole cart;
 *  - plan delivery with domain/clusterPlan (how many riders, pickup order, when each kitchen
 *    starts) and log the decision with its numbers for later model training.
 */

export interface ClusterPartInput {
  restaurantId: string;
  items: Array<{itemId: string; quantity: number; variantId?: string; addOnIds: string[]; note: string}>;
  instructions: string;
  quotedSubtotal?: number | undefined;
}

export interface CreateClusterOrderInput {
  idempotencyKey: string;
  addressId: string;
  parts: ClusterPartInput[];
  tip: number;
  contactless: boolean;
  paymentMethod: "cod";
}

const clusters = () => firestoreDb.collection("clusterOrders");
const decisions = () => firestoreDb.collection("clusterDecisions");

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function clusterIdFor(uid: string, idempotencyKey: string): string {
  return `CL${digest(`${uid}:${idempotencyKey}`, 20).toUpperCase()}`;
}

/** Each part's own idempotency key, stable across retries. */
export function clusterPartKey(idempotencyKey: string, index: number): string {
  return `cl${index}_${digest(`${idempotencyKey}:${index}`, 32)}`;
}

export {partTemperature};

/**
 * Links each order to its rider trip: parts one rider collects together carry the trip's pickup
 * order, so dispatch offers the later pickups to the rider who took the first (services/dispatch).
 */
export function tripLinks(clusterId: string, plan: Pick<ClusterPlan, "trips">, orderIdByRestaurant: Readonly<Record<string, string>>): Record<string, ClusterTripLink> {
  const links: Record<string, ClusterTripLink> = {};
  for (const trip of plan.trips) {
    const orderIds = trip.pickups.map((rid) => orderIdByRestaurant[rid]).filter((id): id is string => Boolean(id));
    if (orderIds.length < 2) continue;
    orderIds.forEach((orderId, stop) => { links[orderId] = {clusterId, orderIds, leadOrderId: orderIds[0] as string, stop}; });
  }
  return links;
}

/**
 * `cancelHeldPart` cancels a part that was created before a later part failed (the
 * callable passes the customer's own cancel transition); it never reached a restaurant.
 */
export async function createClusterOrder(
  uid: string,
  input: CreateClusterOrderInput,
  cancelHeldPart: (orderId: string) => Promise<unknown>,
  now = Date.now(),
) {
  const ids = input.parts.map((part) => part.restaurantId);
  if (input.parts.length < 2 || input.parts.length > 3) throw new DomainError("invalid-argument", "A multi-restaurant order has 2 or 3 restaurants.");
  if (new Set(ids).size !== ids.length) throw new DomainError("invalid-argument", "Each restaurant appears once in the cart.");
  if (input.paymentMethod !== "cod") throw new DomainError("failed-precondition", "Multi-restaurant orders take cash on delivery for now.");
  const clusterId = clusterIdFor(uid, input.idempotencyKey);
  const ref = clusters().doc(clusterId);
  const existing = await ref.get();
  if (existing.exists && existing.data()?.status === "released") {
    if (existing.data()?.customerId !== uid) throw new DomainError("already-exists", "Order idempotency conflict.");
    // Already released and announced: return the bill, never announce twice.
    return {...summary(existing.data() as Record<string, unknown>, await loadParts(existing.data()?.orderIds as string[])), deliveryOtps: [] as string[], released: [] as SavrivoOrder[]};
  }

  // Price every part first: an unavailable item or closed restaurant stops the cart
  // before any order exists.
  const [{address}, ...loaded] = await Promise.all([
    loadCustomerAddress(uid, input.addressId),
    ...input.parts.map((part) => loadRestaurantAndMenu(part.restaurantId)),
  ]);
  const priced = input.parts.map((part, index) => {
    const {restaurant, menuById} = loaded[index] as {restaurant: CatalogRestaurant; menuById: Record<string, CatalogItem>};
    // One rider carries a multi-restaurant trip; a store that delivers itself can't join one.
    if ((restaurant as {selfDelivery?: unknown}).selfDelivery === true) {
      throw new DomainError("failed-precondition", `${restaurant.name} delivers its own orders. Please order from it separately.`);
    }
    try {
      return {restaurant, ...priceCart(part.items, menuById, menuPricingOf(restaurant))};
    } catch {
      throw new DomainError("failed-precondition", `Something in your ${restaurant.name} items is no longer available.`);
    }
  });
  priced.forEach((part, index) => {
    const shown = (input.parts[index] as ClusterPartInput).quotedSubtotal;
    if (shown !== undefined && rupeesToPaise(part.markup?.listSubtotal ?? part.subtotal) !== rupeesToPaise(shown)) {
      throw new DomainError("failed-precondition", "PRICE_CHANGED");
    }
  });
  // What the customer saw: markup restaurants' food GST included.
  // No free delivery partner near one of the stores: stop before any part exists.
  const {assertDeliveryPartnerFreeNear} = await import("./dispatch");
  const {isTestCustomer} = await import("./testAccounts");
  const testOrder = await isTestCustomer(uid);
  for (const part of priced) await assertDeliveryPartnerFreeNear(part.restaurant, testOrder);
  const cartSubtotal = priced.reduce((sum, part) => sum + (part.markup?.listSubtotal ?? part.subtotal), 0);
  const firstFees = await loadServerFees((priced[0] as {restaurant: CatalogRestaurant}).restaurant, address, cartSubtotal);
  const waiveSmallOrderFee = !(firstFees.smallOrderThreshold > 0 && cartSubtotal < firstFees.smallOrderThreshold);

  const orders: SavrivoOrder[] = [];
  const otps: string[] = [];
  try {
    for (let index = 0; index < input.parts.length; index += 1) {
      const part = input.parts[index] as ClusterPartInput;
      const result = await createAuthoritativeOrder(uid, {
        idempotencyKey: clusterPartKey(input.idempotencyKey, index),
        restaurantId: part.restaurantId,
        items: part.items,
        addressId: input.addressId,
        couponCode: "",
        // The tip goes to the rider of the first part; riders of other parts get their usual pay.
        tip: index === 0 ? input.tip : 0,
        deliveryMode: "asap",
        instructions: part.instructions,
        contactless: input.contactless,
        useWallet: false,
        paymentMethod: "cod",
      } as never, {
        cluster: {
          id: clusterId, index, size: input.parts.length,
          waivePlatformFee: index > 0,
          // The first part keeps the fee only when the whole cart is small.
          waiveSmallOrderFee: index > 0 || waiveSmallOrderFee,
        },
      });
      orders.push(result.order);
      otps.push(result.deliveryOtp);
    }
  } catch (error) {
    await Promise.all(orders.map((order) => cancelHeldPart(order.id).catch((cancelError) =>
      logger.error("CLUSTER_PART_CANCEL_FAILED", {clusterId, orderId: order.id, error: String(cancelError)}))));
    logger.warn("CLUSTER_ORDER_FAILED", {clusterId, created: orders.map((order) => order.id), error: String(error)});
    throw error;
  }

  // Learned kitchen times and riding speed for this city and hour (when they beat the rules), and
  // how far the nearest free rider is from each kitchen right now.
  const cityKey = availabilityCityKey((priced[0] as {restaurant: CatalogRestaurant}).restaurant.city);
  const learned = await learnedPlanInputs(cityKey, now).catch(() => ({prepFor: null, minutesPerKm: null}));
  const reach = await nearestRiderMinutes(cityKey, priced.map((part) => ({lat: Number(part.restaurant.lat), lng: Number(part.restaurant.lng)})),
    learned.minutesPerKm, now);
  const legs: ClusterLegInput[] = priced.map((part, index) => ({
    restaurantId: part.restaurant.id,
    lat: Number(part.restaurant.lat),
    lng: Number(part.restaurant.lng),
    prepMinutes: learned.prepFor ?
      learned.prepFor(part.restaurant.id, part.items.reduce((sum, item) => sum + item.quantity, 0), statedPrepMinutes(part.restaurant)) :
      fallbackPrepMinutes(part.restaurant),
    temperature: partTemperature(part.items.map((item) => item.name)),
    riderReachMinutes: reach[index] ?? null,
  }));
  const customerPoint = {lat: Number(address.lat), lng: Number(address.lng)};
  const policy = learned.minutesPerKm ? {...DEFAULT_CLUSTER_POLICY, minutesPerStraightKm: learned.minutesPerKm} : DEFAULT_CLUSTER_POLICY;
  const plan = Number.isFinite(customerPoint.lat) && Number.isFinite(customerPoint.lng) ?
    planClusterDelivery(customerPoint, legs, policy) : null;
  const links = plan ? tripLinks(clusterId, plan, Object.fromEntries(orders.map((order) => [order.restaurantId, order.id]))) : {};

  // Release every part together.
  const batch = firestoreDb.batch();
  const releasedAt = Date.now();
  const startAt = (order: SavrivoOrder) => now + (plan?.kitchenStartDelayMinutes[order.restaurantId] ?? 0) * 60_000;
  for (const order of orders) {
    batch.update(firestoreDb.collection("orders").doc(order.id), {
      clusterHold: FieldValue.delete(),
      kitchenStartAt: startAt(order),
      ...(links[order.id] ? {clusterTrip: links[order.id]} : {}),
      updatedAt: releasedAt,
    });
  }
  const record = {
    clusterId, customerId: uid, status: "released",
    orderIds: orders.map((order) => order.id),
    restaurantIds: ids,
    paymentMethod: input.paymentMethod,
    total: Math.round(orders.reduce((sum, order) => sum + order.total, 0) * 100) / 100,
    plan: plan ? {riders: plan.riders, trips: plan.trips, kitchenStartDelayMinutes: plan.kitchenStartDelayMinutes,
      etaMinutes: plan.etaMinutes, arrivalSpreadMinutes: plan.arrivalSpreadMinutes, reasons: plan.reasons} : null,
    createdAt: now,
  };
  batch.set(ref, record);
  if (plan) {
    batch.set(decisions().doc(clusterId), {
      clusterId, at: now, decision: "plan", version: 2,
      inputs: {learnedPrep: Boolean(learned.prepFor), learnedTravel: Boolean(learned.minutesPerKm), liveRiderReach: reach.some((r) => r !== null)},
      features: clusterPlanFeatures(customerPoint, legs, plan),
      // Filled in by delivery events: what really happened, to compare with the plan.
      outcome: null,
    });
  }
  await batch.commit();
  logger.info("CLUSTER_ORDER_RELEASED", {clusterId, orders: record.orderIds, riders: plan?.riders ?? null});
  // The orders exactly as now stored (no hold flag; Firestore rejects undefined fields).
  const released: SavrivoOrder[] = orders.map(({clusterHold: _held, ...order}) => ({...order, kitchenStartAt: startAt(order as SavrivoOrder),
    ...(links[order.id] ? {clusterTrip: links[order.id]} : {}), updatedAt: releasedAt}));
  return {...summary(record, released), deliveryOtps: otps, released};
}

async function loadParts(orderIds: string[]): Promise<SavrivoOrder[]> {
  const snaps = await Promise.all(orderIds.map((id) => firestoreDb.collection("orders").doc(id).get()));
  return snaps.filter((snap) => snap.exists).map((snap) => snap.data() as SavrivoOrder);
}

/** One bill for the customer, split by restaurant. */
export function clusterBill(orders: readonly SavrivoOrder[]) {
  const parts = orders.map((order) => ({
    orderId: order.id,
    restaurant: order.restaurant,
    // Markup restaurants: food shown GST-inclusive, tax is GST on fees only.
    subtotal: order.pricing.markup?.listSubtotal ?? order.pricing.subtotal,
    tax: order.pricing.markup?.tax ?? Number((order.pricing as unknown as Record<string, unknown>).tax ?? 0),
    deliveryFee: order.pricing.deliveryFee,
    platformFee: Number((order.pricing as unknown as Record<string, unknown>).platformFee ?? 0),
    smallOrderFee: order.pricing.smallOrderFee,
    total: order.total,
  }));
  const total = Math.round(parts.reduce((sum, part) => sum + part.total, 0) * 100) / 100;
  return {parts, total};
}

function summary(record: Record<string, unknown>, orders: readonly SavrivoOrder[]) {
  return {clusterId: record.clusterId as string, bill: clusterBill(orders), plan: record.plan ?? null};
}
