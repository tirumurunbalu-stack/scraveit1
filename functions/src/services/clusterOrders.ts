import {createHash} from "node:crypto";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {
  CARE_LABELS,
  clusterCellsFor,
  clusterSettings,
  inOneClusterArea,
  partCare,
  pickupOrder,
  stopPickupMeters,
  type CareLevel,
  type ClusterSettings,
} from "../domain/clusterOrder";
import {deterministicOrderId, priceCart} from "../domain/order";
import {riderOfferPayout, riderPayoutBreakdown} from "../domain/riderJob";
import {DomainError} from "../errors";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import {orderRef} from "../firestorePaths";
import type {CatalogRestaurant, OrderCluster, OrderClusterStop, SavrivoOrder} from "../types";
import {loadRestaurantAndMenu} from "./catalog";
import {notifyRestaurantClusterPack} from "./notifications";
import {cancelClusterPart, createAuthoritativeOrder, followClusterArrival} from "./orders";
import type {ClusterOrderInput, ClusterPreviewInput, CreateOrderInput} from "./serviceTypes";

/**
 * Cluster orders (domain/clusterOrder.ts): a customer orders from several restaurants in one
 * area at once. Each restaurant's part is placed as an ordinary order, priced as part of the
 * whole (one delivery fee, a stop fee for each extra restaurant), and the parts share one
 * delivery code. Dispatch finds one rider for the first pickup and gives them every part
 * (services/dispatch.ts); the rider collects in the order planned here.
 */

const CLUSTERS = "orderClusters";
/** A cluster still "placing" after this long was interrupted; its parts are withdrawn. */
const PLACING_TIMEOUT_MS = 3 * 60_000;

export function clusterIdFor(customerId: string, idempotencyKey: string): string {
  return `cl_${createHash("sha256").update(`${customerId}|${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

function clusterRef(database: FirestoreLike, clusterId: string) {
  return database.collection(CLUSTERS).doc(clusterId);
}

interface PlannedPart {
  restaurantId: string;
  restaurant: CatalogRestaurant;
  items: ClusterPreviewInput["parts"][number]["items"];
  subtotal: number;
  lat: number;
  lng: number;
  care: CareLevel;
  kitchenMinutes: number;
}

interface ClusterPlan {
  settings: ClusterSettings;
  parts: PlannedPart[];
  clusterSubtotal: number;
}

/** Checks the restaurants form one area and works out the pickup order. */
async function planCluster(input: ClusterPreviewInput, database: FirestoreLike = firestoreDb): Promise<ClusterPlan> {
  const settingsSnapshot = await database.collection("settings").doc("customer").get();
  const settings = clusterSettings(settingsSnapshot.exists ? settingsSnapshot.data() : {});
  if (!settings.enabled) {
    throw new DomainError("failed-precondition", "Ordering from several restaurants at once is switched off right now.");
  }
  if (input.parts.length > settings.maxRestaurants) {
    throw new DomainError("invalid-argument", `One order can have up to ${settings.maxRestaurants} restaurants.`);
  }
  const ids = input.parts.map((part) => part.restaurantId);
  if (new Set(ids).size !== ids.length) throw new DomainError("invalid-argument", "Each restaurant appears once in an order.");
  const loaded = await Promise.all(input.parts.map((part) => loadRestaurantAndMenu(part.restaurantId)));
  if (!inOneClusterArea(loaded.map(({restaurant}) => restaurant))) {
    throw new DomainError("failed-precondition",
      "These restaurants are too far apart for one rider. Choose restaurants within about 2 km of each other.");
  }
  const parts = input.parts.map((part, index): PlannedPart => {
    const {restaurant, menuById} = loaded[index]!;
    const {items, subtotal} = priceCart(part.items, menuById);
    return {
      restaurantId: restaurant.id, restaurant, items: part.items, subtotal,
      lat: Number(restaurant.lat), lng: Number(restaurant.lng),
      care: partCare(items), kitchenMinutes: Number(restaurant.etaMin) || 20,
    };
  });
  return {
    settings,
    parts: pickupOrder(parts),
    clusterSubtotal: parts.reduce((sum, part) => sum + part.subtotal, 0),
  };
}

function stopsFor(plan: ClusterPlan, orderIds: string[]): OrderClusterStop[] {
  return plan.parts.map((part, index) => ({
    orderId: orderIds[index]!,
    restaurantId: part.restaurantId,
    restaurant: String(part.restaurant.name ?? "Restaurant").slice(0, 120),
    lat: part.lat,
    lng: part.lng,
    care: part.care,
    careLabel: CARE_LABELS[part.care],
  }));
}

function partInput(input: ClusterPreviewInput & Partial<ClusterOrderInput>, part: PlannedPart, index: number, key: string): CreateOrderInput {
  const first = index === 0;
  return {
    idempotencyKey: key,
    restaurantId: part.restaurantId,
    items: part.items,
    addressId: input.addressId,
    // Coupon, tip and wallet go with the first pickup, once for the whole order.
    couponCode: first ? input.couponCode : "",
    tip: first ? input.tip : 0,
    useWallet: first && input.useWallet,
    deliveryMode: "asap",
    instructions: input.instructions ?? "",
    contactless: input.contactless ?? false,
    paymentMethod: "cod",
  };
}

function partOptions(plan: ClusterPlan, stops: OrderClusterStop[], clusterId: string, index: number, otp?: string) {
  const part = plan.parts[index]!;
  const previous = index > 0 ? plan.parts[index - 1]! : null;
  const pickupMeters = previous ? stopPickupMeters(previous, part) : 0;
  const role: OrderCluster["role"] = index === 0 ? "anchor" : "stop";
  const order: OrderCluster = {
    id: clusterId,
    leg: index + 1,
    size: plan.parts.length,
    role,
    stops,
    ...(previous ? {stopKm: Math.round(pickupMeters / 100) / 10, stopFee: plan.settings.stopFee} : {}),
  };
  return {
    order,
    fees: {role, clusterSubtotal: plan.clusterSubtotal, stopFee: plan.settings.stopFee, pickupMeters},
    ...(otp ? {otp} : {}),
  };
}

export interface ClusterPreviewPart {
  restaurantId: string;
  restaurant: string;
  leg: number;
  careLabel: string;
  subtotal: number;
  total: number;
  pricing: SavrivoOrder["pricing"];
  etaMin: number;
  etaMax: number;
}

/** The whole order priced exactly as placing it will price it, in pickup order. Nothing is saved. */
export async function previewClusterOrder(uid: string, input: ClusterPreviewInput): Promise<{
  parts: ClusterPreviewPart[];
  subtotal: number;
  total: number;
  stopFee: number;
  etaMin: number;
  etaMax: number;
  couponMessage?: string;
}> {
  const plan = await planCluster(input);
  const stops = stopsFor(plan, plan.parts.map((_, index) => `preview-${index + 1}`));
  const price = async (couponCode: string) => Promise.all(plan.parts.map(async (part, index) => {
    const {order} = await createAuthoritativeOrder(uid,
      partInput({...input, couponCode}, part, index, `preview-cluster-part-${index + 1}`),
      {cluster: partOptions(plan, stops, "preview", index), dryRun: true});
    return order;
  }));
  let couponMessage: string | undefined;
  let orders: SavrivoOrder[];
  try {
    orders = await price(input.couponCode);
  } catch (error) {
    if (!input.couponCode || !(error instanceof DomainError)) throw error;
    // A coupon that doesn't apply shouldn't hide the bill: price without it and say why.
    couponMessage = error.message;
    orders = await price("");
  }
  const parts = orders.map((order, index): ClusterPreviewPart => ({
    restaurantId: order.restaurantId,
    restaurant: order.restaurant,
    leg: index + 1,
    careLabel: stops[index]!.careLabel,
    subtotal: order.pricing.subtotal,
    total: order.total,
    pricing: order.pricing,
    etaMin: order.etaMin,
    etaMax: order.etaMax,
  }));
  const extraMinutes = 4 * (parts.length - 1);
  return {
    parts,
    subtotal: Math.round(parts.reduce((sum, part) => sum + part.subtotal, 0) * 100) / 100,
    total: Math.round(parts.reduce((sum, part) => sum + part.total, 0) * 100) / 100,
    stopFee: plan.settings.stopFee,
    etaMin: Math.max(...parts.map((part) => part.etaMin)) + extraMinutes,
    etaMax: Math.max(...parts.map((part) => part.etaMax)) + extraMinutes,
    ...(couponMessage ? {couponMessage} : {}),
  };
}

/**
 * Places every part. The cluster record is written first as "placing"; if a part fails, the parts
 * already placed are cancelled before their kitchens start and the record is marked failed, so a
 * restaurant is never left cooking half an order. A retry with the same key after a lost
 * response returns the order already placed.
 */
export async function createClusterOrder(uid: string, input: ClusterOrderInput): Promise<{
  clusterId: string;
  orders: SavrivoOrder[];
  deliveryOtp: string;
  recovered: boolean;
}> {
  const clusterId = clusterIdFor(uid, input.idempotencyKey);
  const ref = clusterRef(firestoreDb, clusterId);
  const existing = await ref.get();
  const record = existing.exists ? existing.data() as {customerId?: string; status?: string} : null;
  if (record && record.customerId !== uid) throw new DomainError("already-exists", "Order idempotency conflict.");
  if (record?.status === "failed") {
    throw new DomainError("aborted", "That order didn't go through, so nothing was placed. Please place it again.");
  }
  const plan = await planCluster(input);
  const keys = plan.parts.map((_, index) => `${input.idempotencyKey}-c${index + 1}`);
  const orderIds = keys.map((key) => deterministicOrderId(uid, key));
  const stops = stopsFor(plan, orderIds);
  const now = Date.now();
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) return;
    transaction.set(ref, {
      id: clusterId, customerId: uid, idempotencyKey: input.idempotencyKey, status: "placing",
      orderIds, stops, size: stops.length, createdAt: now, updatedAt: now,
    });
  });
  const placed: Array<{order: SavrivoOrder; deliveryOtp: string; recovered: boolean}> = [];
  try {
    for (let index = 0; index < plan.parts.length; index++) {
      const result = await createAuthoritativeOrder(uid, partInput(input, plan.parts[index]!, index, keys[index]!),
        {cluster: partOptions(plan, stops, clusterId, index, placed[0]?.deliveryOtp)});
      placed.push(result);
    }
  } catch (error) {
    logger.warn("CLUSTER_ORDER_PLACING_FAILED", {clusterId, placed: placed.length, error: String(error)});
    await withdrawParts(clusterId, orderIds, "This multi-restaurant order couldn't be placed in full");
    throw error;
  }
  await ref.set({status: "placed", placedAt: Date.now(), updatedAt: Date.now()}, {merge: true});
  logger.info("CLUSTER_ORDER_PLACED", {clusterId, size: stops.length, restaurants: stops.map((stop) => stop.restaurantId)});
  return {
    clusterId,
    orders: placed.map((result) => result.order),
    deliveryOtp: placed[0]!.deliveryOtp,
    recovered: placed.every((result) => result.recovered),
  };
}

async function withdrawParts(clusterId: string, orderIds: string[], reason: string): Promise<void> {
  await clusterRef(firestoreDb, clusterId).set({status: "failed", updatedAt: Date.now()}, {merge: true});
  await Promise.all(orderIds.map((orderId) => cancelClusterPart(orderId, reason)
    .catch((error) => logger.error("CLUSTER_PART_WITHDRAW_FAILED", {clusterId, orderId, error: String(error)}))));
}

/** Clusters whose placing was interrupted (the function stopped half way): withdraw their parts. */
export async function sweepUnfinishedClusterOrders(now = Date.now()): Promise<number> {
  const snapshot = await firestoreDb.collection(CLUSTERS).where("status", "==", "placing").limit(50).get();
  let withdrawn = 0;
  for (const doc of snapshot.docs) {
    const cluster = doc.data() as {createdAt?: number; orderIds?: string[]};
    if (now - Number(cluster.createdAt ?? 0) < PLACING_TIMEOUT_MS) continue;
    await withdrawParts(doc.id, cluster.orderIds ?? [], "This multi-restaurant order was interrupted while being placed");
    withdrawn++;
  }
  if (withdrawn) logger.info("CLUSTER_ORDERS_WITHDRAWN", {withdrawn});
  return withdrawn;
}

/**
 * Fills in each restaurant's cluster hexagons (the listing trigger keeps them right from then on),
 * so restaurants listed before cluster orders existed can be combined too. At most once a day.
 */
export async function refreshRestaurantClusterCells(now = Date.now(), database: FirestoreLike = firestoreDb): Promise<number> {
  const marker = database.collection("maintenance").doc("clusterCells");
  const last = await marker.get();
  if (last.exists && now - Number((last.data() as {refreshedAt?: number}).refreshedAt ?? 0) < 24 * 3_600_000) return 0;
  await marker.set({refreshedAt: now});
  const snapshot = await database.collection("restaurants").limit(2000).get();
  let updated = 0;
  for (const doc of snapshot.docs) {
    const restaurant = doc.data() as {lat?: unknown; lng?: unknown; clusterCell?: unknown};
    const cells = clusterCellsFor(restaurant.lat, restaurant.lng);
    if (!cells || cells.clusterCell === restaurant.clusterCell) continue;
    await database.collection("restaurants").doc(doc.id).update(cells);
    updated++;
  }
  if (updated) logger.info("RESTAURANT_CLUSTER_CELLS_FILLED", {updated});
  return updated;
}

const LIVE = (order: SavrivoOrder | null | undefined): order is SavrivoOrder =>
  !!order && order.status !== "Cancelled" && order.status !== "Delivered";

async function partsOf(cluster: OrderCluster, database: FirestoreLike = firestoreDb): Promise<Array<SavrivoOrder | null>> {
  const snapshots = await Promise.all(cluster.stops.map((stop) => orderRef(database, stop.orderId).get()));
  return snapshots.map((snapshot) => snapshot.exists ? snapshot.data() as SavrivoOrder : null);
}

/** Whether this part is the one the rider is found for (the first pickup, or the part that took over). */
export function leadsCluster(order: SavrivoOrder): boolean {
  return !order.cluster || order.cluster.role === "anchor" || !!order.cluster.leadSince;
}

/**
 * Status changes on a cluster part (from onOrderUpdated):
 * - the first pickup cancelled before a rider was found: the next live part takes over finding one;
 * - the tracked part near or at the customer: the other parts in the rider's bag are too;
 * - a part handed to the rider: the next restaurant is told to pack now, so what melts or goes
 *   soggy is packed just before the rider arrives.
 * Returns the part that took over finding the rider, for the caller to dispatch.
 */
export async function onClusterPartStatus(before: SavrivoOrder, order: SavrivoOrder): Promise<SavrivoOrder | null> {
  const cluster = order.cluster;
  if (!cluster || before.status === order.status) return null;
  if (order.status === "Handed to rider") {
    const next = cluster.stops[cluster.leg];
    if (next) {
      const [nextOrder] = await partsOf({...cluster, stops: [next]});
      if (LIVE(nextOrder) && ["Accepted", "Preparing", "Ready for pickup", "Assigned"].includes(nextOrder.status)) {
        await notifyRestaurantClusterPack({
          restaurantId: next.restaurantId,
          orderId: next.orderId,
          title: "Rider on the way: pack now",
          body: `The rider has picked up from ${cluster.stops[cluster.leg - 1]?.restaurant ?? "the previous restaurant"} and comes to you next (pickup ${cluster.leg + 1} of ${cluster.size}).`,
        }).catch((error) => logger.warn("CLUSTER_PACK_NOTIFY_FAILED", {orderId: next.orderId, error: String(error)}));
      }
    }
    return null;
  }
  if ((order.status === "Near you" || order.status === "Arrived") && order.riderId) {
    await Promise.all(cluster.stops.filter((stop) => stop.orderId !== order.id).map((stop) =>
      followClusterArrival(stop.orderId, order.riderId!, order.status as "Near you" | "Arrived", order.id)
        .catch((error) => logger.warn("CLUSTER_ARRIVAL_FOLLOW_FAILED", {orderId: stop.orderId, error: String(error)}))));
    return null;
  }
  if (order.status !== "Cancelled" || !leadsCluster(order)) return null;
  const parts = await partsOf(cluster);
  if (parts.some((part) => LIVE(part) && part.riderId)) return null;
  const successor = parts.find((part) => LIVE(part) && part.id !== order.id);
  if (!successor) return null;
  const ref = orderRef(firestoreDb, successor.id);
  const promoted = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
    if (!LIVE(current) || !current.cluster || current.riderId || leadsCluster(current)) return null;
    const next: SavrivoOrder = {...current, cluster: {...current.cluster, leadSince: Date.now()}};
    transaction.set(ref, next);
    return next;
  });
  if (promoted) logger.info("CLUSTER_LEAD_PROMOTED", {clusterId: cluster.id, from: order.id, to: promoted.id});
  return promoted;
}

/**
 * What a rider is offered for a cluster's trip: every live pickup in order and the pay for all of
 * them together (the first pickup's trip pay plus each stop's), so the offer shows the whole job.
 */
export async function clusterTripOffer(order: SavrivoOrder): Promise<{
  pickups: number;
  restaurants: string[];
  payout: number;
  payoutBreakdown: {tripPay: number; incentives: number; tip: number; total: number};
} | null> {
  if (!order.cluster) return null;
  const parts = (await partsOf(order.cluster)).map((part, index) => part?.id === order.id ? order : part)
    .filter((part): part is SavrivoOrder => LIVE(part));
  if (parts.length < 2) return null;
  const round = (value: number) => Math.round(value * 100) / 100;
  const pay = parts.map((part) => riderPayoutBreakdown(part));
  const add = (key: "tripPay" | "incentives" | "tip" | "total") => round(pay.reduce((sum, entry) => sum + entry[key], 0));
  return {
    pickups: parts.length,
    restaurants: parts.map((part) => String(part.restaurant ?? "Restaurant").slice(0, 80)),
    payout: round(parts.reduce((sum, part) => sum + riderOfferPayout(part), 0)),
    payoutBreakdown: {tripPay: add("tripPay"), incentives: add("incentives"), tip: add("tip"), total: add("total")},
  };
}

/** The rider carrying this cluster: the rider of any live part that has one. */
export async function clusterRiderId(order: SavrivoOrder): Promise<string> {
  if (!order.cluster) return "";
  const parts = await partsOf(order.cluster);
  return parts.find((part) => LIVE(part) && part.id !== order.id && part.riderId)?.riderId ?? "";
}

/**
 * Trip updates the customer already gets from the part leading the trip; repeating them for every
 * restaurant would send three "out for delivery" messages for one delivery.
 */
export function quietClusterTripUpdate(order: SavrivoOrder): boolean {
  return !!order.cluster && !leadsCluster(order) &&
    ["Assigned", "Handed to rider", "Out for delivery", "Near you", "Arrived", "Delivered"].includes(order.status);
}
