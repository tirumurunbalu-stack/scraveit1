import {createHash, randomUUID} from "node:crypto";
import {logger} from "firebase-functions";
import type {MulticastMessage} from "firebase-admin/messaging";
import {firestoreDb, messaging} from "../admin";
import type {DocumentReferenceLike, FirestoreLike} from "../firestoreTypes";
import {FieldValue} from "../firestoreTypes";
import {
  buildCustomerBroadcastMessage,
  buildRemoveRiderOfferMessage,
  buildRestaurantNewOrderMessage,
  buildRiderOfferMessage,
  buildRiderWakeMessage,
  buildStopRestaurantAlarmMessage,
  buildOrderCancelledNotice,
  type CustomerBroadcastPayload,
} from "../domain/notificationMessages";
import type {
  NotificationOutboxInput,
  NotificationOutboxRecord,
  RtdbObject,
} from "../domain/outbox";
import {deterministicOutboxEventId} from "../domain/outbox";
import {isStaleDeviceToken} from "../domain/deviceTokens";
import {deviceTokenOwnerRef} from "./deviceTokens";
import {restaurantRef} from "../firestorePaths";
import {storeTypeOf} from "../domain/restaurantOnboarding";
import {afterPickupPlan} from "../domain/foodRescue";
import {cancelledWithFeeBeforePickup} from "../domain/customerCancel";
import type {OrderStatus, SavrivoOrder} from "../types";
import {
  enqueueNotification,
  processNotification,
  type ProcessNotificationResult,
} from "./outbox";

interface DeviceTokenRecord {
  token?: string;
  enabled?: boolean;
  app?: "customer" | "restaurant" | "rider" | "admin";
  updatedAt?: number;
}

function deviceTokensRef(database: FirestoreLike, uid: string): DocumentReferenceLike {
  return database.collection("deviceTokens").doc(uid);
}

function tokenRecords(value: unknown): Array<{key: string; value: DeviceTokenRecord}> {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, DeviceTokenRecord>)
    .map(([key, record]) => ({key, value: record ?? {}}))
    .filter(({value}) => value.enabled !== false && typeof value.token === "string" && value.token.length > 20);
}

async function tokensForUsers(uids: string[], app?: DeviceTokenRecord["app"]): Promise<Array<{uid: string; key: string; token: string}>> {
  const unique = [...new Set(uids.filter(Boolean))];
  const snapshots = await Promise.all(unique.map((uid) => deviceTokensRef(firestoreDb, uid).get()));
  const now = Date.now();
  const stale = new Map<string, string[]>();
  const drop = (uid: string, key: string) => stale.set(uid, [...(stale.get(uid) ?? []), key]);
  const records = snapshots.flatMap((snapshot, index) => tokenRecords(snapshot.exists ? snapshot.data() : null)
    .filter(({value}) => !app || value.app === app)
    // A customer phone unused for a month is dropped (see isStaleDeviceToken).
    .filter(({key, value}) => !isStaleDeviceToken({app: value.app ?? "customer", updatedAt: Number(value.updatedAt ?? 0)}, now) || (drop(unique[index] ?? "", key), false))
    .map(({key, value}) => ({uid: unique[index] ?? "", key, token: String(value.token)})));
  // A phone now signed in to another account is skipped, and dropped from this account.
  const owners = await Promise.all(records.map((record) => deviceTokenOwnerRef(firestoreDb, record.key).get().catch(() => null)));
  const kept = records.filter((record, index) => {
    const owner = owners[index];
    const ownerUid = owner?.exists ? String((owner.data() as {uid?: string} | undefined)?.uid ?? "") : "";
    if (!ownerUid || ownerUid === record.uid) return true;
    drop(record.uid, record.key);
    return false;
  });
  if (stale.size) {
    await Promise.all([...stale.entries()].map(([uid, keys]) => deviceTokensRef(firestoreDb, uid)
      .update(Object.fromEntries(keys.map((key) => [key, FieldValue.delete()])))))
      .catch((error) => logger.warn("STALE_DEVICE_TOKEN_CLEANUP_FAILED", {count: stale.size, error: String(error)}));
  }
  return kept;
}

async function restaurantUserIds(restaurantId: string): Promise<string[]> {
  let normalized: Array<{uid: string; active?: boolean}> = [];
  try {
    // Nothing in this codebase provisions restaurantMembers today - it is
    // managed entirely outside Cloud Functions. Unlike the single-membership
    // lookups elsewhere (authz.ts, mediaUploads.ts, deviceTokens.ts), which
    // read one composite-ID document directly, this bulk "every member of
    // this restaurant" query needs a real `restaurantId` field on each
    // document - the old nested RTDB path could scope by prefix for free,
    // but a flat Firestore collection cannot.
    const membersSnapshot = await firestoreDb.collection("restaurantMembers")
      .where("restaurantId", "==", restaurantId).get();
    normalized = membersSnapshot.docs.map((doc) => {
      const data = doc.data() as {uid?: string; active?: boolean};
      return {uid: String(data.uid ?? doc.id.split("_").slice(1).join("_")), active: data.active};
    });
  } catch (error) {
    logger.warn("RESTAURANT_MEMBERSHIP_ROUTING_QUERY_FAILED", {restaurantId, error});
  }
  let legacy: Array<{uid: string; active?: boolean}> = [];
  try {
    const legacySnapshot = await firestoreDb.collection("staff")
      .where("restaurantId", "==", restaurantId).get();
    legacy = legacySnapshot.docs.map((doc) => ({uid: doc.id, active: (doc.data() as {active?: boolean}).active}));
  } catch (error) {
    // Normalized memberships are authoritative. A legacy migration lookup
    // must never block alerts to already-normalized restaurant devices.
    logger.warn("LEGACY_RESTAURANT_ROUTING_QUERY_FAILED", {restaurantId, error});
  }
  return [...new Set([
    ...normalized.filter((member) => member.active === true).map((member) => member.uid),
    ...legacy.filter((member) => member.active === true).map((member) => member.uid),
  ])];
}

interface CustomerBroadcastRecord {
  id: string;
  title: string;
  message: string;
  audience?: string;
  city?: string;
  area?: string;
  restaurantId?: string;
  deepLink?: string;
  active?: boolean;
}

interface CustomerProfileForBroadcast {
  preferences?: {notifications?: boolean};
  addresses?: Array<{id?: string; city?: string; area?: string}>;
  selectedAddressId?: string;
}

function normalizeAudienceKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Resolved at delivery time (not scheduling time) so a retry always reflects
 * the latest opt-in/address data, matching how every other recipient kind in
 * this outbox works.
 */
async function broadcastAudienceUserIds(broadcastId: string): Promise<string[]> {
  const broadcastSnapshot = await firestoreDb.collection("customerBroadcasts").doc(broadcastId).get();
  const broadcast = broadcastSnapshot.exists ? broadcastSnapshot.data() as CustomerBroadcastRecord : null;
  if (!broadcast || broadcast.active === false) return [];
  const audience = broadcast.audience || "all";

  if (audience === "restaurant") {
    if (!broadcast.restaurantId) return [];
    const [ordersSnapshot, usersSnapshot] = await Promise.all([
      // The privacy-scoped restaurant order projection (orderProjection.ts)
      // carries `restaurantId`/`customerId` fields directly - a real query,
      // not the old RTDB nested-path scan this replaces.
      firestoreDb.collection("restaurantOrders").where("restaurantId", "==", broadcast.restaurantId).get(),
      firestoreDb.collection("users").get(),
    ]);
    const candidateUids = [...new Set(
      ordersSnapshot.docs
        .map((doc) => (doc.data() as {customerId?: string}).customerId)
        .filter((uid): uid is string => Boolean(uid)),
    )];
    const users = new Map(usersSnapshot.docs.map((doc) => [doc.id, doc.data() as CustomerProfileForBroadcast]));
    return candidateUids.filter((uid) => users.get(uid)?.preferences?.notifications !== false);
  }

  const usersSnapshot = await firestoreDb.collection("users").get();
  const users = Object.fromEntries(usersSnapshot.docs.map((doc) => [doc.id, doc.data() as CustomerProfileForBroadcast]));
  const targetCity = normalizeAudienceKey(broadcast.city);
  const targetArea = normalizeAudienceKey(broadcast.area);
  return Object.entries(users).filter(([, profile]) => {
    if (!profile || profile.preferences?.notifications === false) return false;
    if (audience === "all") return true;
    const addresses = Array.isArray(profile.addresses) ? profile.addresses : [];
    const current = addresses.find((entry) => entry?.id === profile.selectedAddressId) ?? addresses[0];
    if (!current) return false;
    if (audience === "city") return normalizeAudienceKey(current.city || current.area) === targetCity;
    if (audience === "area") return normalizeAudienceKey(current.area) === targetArea;
    return false;
  }).map(([uid]) => uid);
}

/**
 * Deduplicated per occurrence (id + the scheduledAt that was actually due),
 * not just per broadcast id, so a recurring broadcast's next occurrence -
 * and a one-time broadcast that was rescheduled and reactivated after
 * sending - are never blocked by an earlier occurrence's dedup record.
 */
export async function notifyCustomerBroadcast(broadcast: CustomerBroadcastPayload): Promise<void> {
  await enqueueAndAttempt({
    eventType: "CUSTOMER_BROADCAST",
    aggregateType: "customerBroadcast",
    aggregateId: broadcast.id,
    deduplicationKey: `customer-broadcast:${broadcast.id}:${broadcast.scheduledAt}`,
    recipient: {kind: "broadcast", id: broadcast.id, app: "customer"},
    message: storedMessage(buildCustomerBroadcastMessage(broadcast)),
  });
}

export interface NotificationDeliveryCounts {
  targetCount: number;
  successCount: number;
  permanentFailureCount: number;
  transientFailureCount: number;
  successfulTargetIds: string[];
  permanentFailureTargetIds: string[];
  transientFailureTargetIds: string[];
}

const PERMANENT_TOKEN_ERRORS = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/** Stable physical FCM endpoint identity; the token itself is never persisted. */
function deliveryTargetId(token: string): string {
  const digest = createHash("sha256").update(token).digest("hex").slice(0, 48);
  return `device-${digest}`;
}

async function sendToUsers(
  uids: string[],
  message: Omit<MulticastMessage, "tokens">,
  app?: DeviceTokenRecord["app"],
  settledTargetIds: ReadonlySet<string> = new Set(),
): Promise<NotificationDeliveryCounts> {
  const grouped = new Map<string, {
    targetId: string;
    token: string;
    registrations: Array<{uid: string; key: string}>;
  }>();
  for (const record of await tokensForUsers(uids, app)) {
    const targetId = deliveryTargetId(record.token);
    if (settledTargetIds.has(targetId)) continue;
    const existing = grouped.get(targetId);
    if (existing) existing.registrations.push({uid: record.uid, key: record.key});
    else grouped.set(targetId, {
      targetId,
      token: record.token,
      registrations: [{uid: record.uid, key: record.key}],
    });
  }
  const records = [...grouped.values()];
  const counts: NotificationDeliveryCounts = {
    targetCount: records.length,
    successCount: 0,
    permanentFailureCount: 0,
    transientFailureCount: 0,
    successfulTargetIds: [],
    permanentFailureTargetIds: [],
    transientFailureTargetIds: [],
  };
  for (let offset = 0; offset < records.length; offset += 500) {
    const batch = records.slice(offset, offset + 500);
    let response;
    try {
      response = await messaging.sendEachForMulticast({...message, tokens: batch.map((entry) => entry.token)});
    } catch (error) {
      // Preserve outcomes from earlier chunks. Treat this entire chunk as
      // transient so successful devices from prior chunks are checkpointed
      // and only this unresolved chunk is retried.
      counts.transientFailureCount += batch.length;
      counts.transientFailureTargetIds.push(...batch.map((entry) => entry.targetId));
      logger.warn("FCM_BATCH_SEND_FAILED", {targetCount: batch.length, error});
      continue;
    }
    counts.successCount += response.successCount;
    // One document per uid (a map of token keys), not a flat path fan-out -
    // group removals by uid so each affected user gets one field-deleting
    // update() instead of one write per token key.
    const removalsByUid = new Map<string, Set<string>>();
    response.responses.forEach((result, index) => {
      const code = result.error?.code;
      const record = batch[index];
      if (!record) return;
      if (result.success) {
        counts.successfulTargetIds.push(record.targetId);
        return;
      }
      if (code && PERMANENT_TOKEN_ERRORS.has(code)) {
        counts.permanentFailureCount += 1;
        counts.permanentFailureTargetIds.push(record.targetId);
        record.registrations.forEach(({uid, key}) => {
          if (!removalsByUid.has(uid)) removalsByUid.set(uid, new Set());
          removalsByUid.get(uid)!.add(key);
        });
      } else {
        counts.transientFailureCount += 1;
        counts.transientFailureTargetIds.push(record.targetId);
      }
    });
    if (removalsByUid.size) {
      try {
        await Promise.all([...removalsByUid.entries()].map(([uid, keys]) => deviceTokensRef(firestoreDb, uid).update(
          Object.fromEntries([...keys].map((key) => [key, FieldValue.delete()])),
        )));
      } catch (error) {
        // The persisted target outcome remains authoritative even when best-
        // effort token cleanup is temporarily unavailable.
        logger.error("FCM_INVALID_TOKEN_CLEANUP_FAILED", {count: removalsByUid.size, error});
      }
    }
    if (response.failureCount) logger.warn("FCM batch had failures", {failureCount: response.failureCount});
  }
  return counts;
}

function storedMessage(message: Omit<MulticastMessage, "tokens">): RtdbObject {
  return JSON.parse(JSON.stringify(message)) as RtdbObject;
}

function transientDeliveryError(code: string, message: string): Error & {code: string; retryable: boolean} {
  return Object.assign(new Error(message), {code, retryable: true});
}

function permanentDeliveryError(code: string, message: string): Error & {code: string; retryable: boolean} {
  return Object.assign(new Error(message), {code, retryable: false});
}

function tokenlessMessage(record: NotificationOutboxRecord): Omit<MulticastMessage, "tokens"> {
  if (!record.message || typeof record.message !== "object" || Array.isArray(record.message)) {
    throw permanentDeliveryError("INVALID_STORED_MESSAGE", "The stored notification payload is invalid.");
  }
  return record.message as unknown as Omit<MulticastMessage, "tokens">;
}

function assertEventStillDeliverable(record: NotificationOutboxRecord, now = Date.now()): void {
  if (record.eventType !== "RIDER_ORDER_OFFER") return;
  const data = record.message.data;
  const expiresAt = data && typeof data === "object" && !Array.isArray(data) ?
    Number((data as RtdbObject).expiresAt ?? 0) : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw permanentDeliveryError("RIDER_OFFER_EXPIRED", "The rider offer expired before it could be delivered.");
  }
}

/** The durable outbox worker resolves current device tokens at delivery time. */
export async function deliverNotificationRecord(
  record: NotificationOutboxRecord,
): Promise<NotificationDeliveryCounts> {
  assertEventStillDeliverable(record);
  let uids: string[];
  switch (record.recipient.kind) {
  case "restaurant":
    uids = await restaurantUserIds(record.recipient.id);
    break;
  case "broadcast":
    uids = await broadcastAudienceUserIds(record.recipient.id);
    break;
  case "user":
  case "rider":
  case "admin":
    uids = [record.recipient.id];
    break;
  default:
    throw permanentDeliveryError("UNSUPPORTED_RECIPIENT", "The notification recipient type is unsupported.");
  }
  try {
    const settledTargetIds = new Set([
      ...(record.targetProgress?.successfulTargetIds ?? []),
      ...(record.targetProgress?.permanentFailureTargetIds ?? []),
    ]);
    return await sendToUsers(uids, tokenlessMessage(record), record.recipient.app, settledTargetIds);
  } catch (error) {
    if ((error as {retryable?: unknown})?.retryable === false) throw error;
    throw transientDeliveryError(
      "FCM_DELIVERY_ERROR",
      error instanceof Error ? error.message.slice(0, 500) : "Firebase Messaging delivery failed.",
    );
  }
}

function objectValue(value: unknown): RtdbObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RtdbObject : null;
}

/**
 * Give every retry a stable provider identity. Purpose-built data-only order
 * alarms retain their existing collapse keys; rendered notifications also get
 * an Android tag so retrying a partial multi-device delivery replaces the same
 * event instead of stacking duplicates.
 */
function withStableRetryIdentity(input: NotificationOutboxInput): NotificationOutboxInput {
  const eventId = deterministicOutboxEventId(input);
  const deliveryId = `outbox-${eventId.slice("notification-".length)}`;
  const message = JSON.parse(JSON.stringify(input.message)) as RtdbObject;
  const android = objectValue(message.android);
  if (android) {
    if (android.collapseKey === undefined) android.collapseKey = deliveryId;
    const notification = objectValue(android.notification);
    if (notification && notification.tag === undefined) notification.tag = deliveryId;
  }
  const apns = objectValue(message.apns);
  const headers = apns ? objectValue(apns.headers) : null;
  if (headers && headers["apns-collapse-id"] === undefined) headers["apns-collapse-id"] = deliveryId;
  return {...input, message};
}

async function enqueueAndAttempt(input: NotificationOutboxInput): Promise<ProcessNotificationResult> {
  const record = await enqueueNotification(withStableRetryIdentity(input));
  return processNotification(
    record.eventId,
    `immediate-${randomUUID()}`,
    deliverNotificationRecord,
    record,
  );
}

/** True when the latest "Arrived" came from the partner waiting 3 minutes at the customer's campus. */
export function arrivedAtCampusGate(order: SavrivoOrder): boolean {
  const arrived = Object.values(order.statusHistory ?? {})
    .filter((event) => event?.status === "Arrived")
    .sort((a, b) => Number(b.at) - Number(a.at))[0];
  return String(arrived?.proof ?? "").startsWith("campus:");
}

function statusCopy(order: SavrivoOrder): {title: string; body: string} {
  const status = order.status;
  if (status === "Arrived" && arrivedAtCampusGate(order)) {
    return {
      title: "Your delivery partner is waiting near the gate",
      body: "Please call them or meet them at the gate. Share the delivery OTP only after receiving the order.",
    };
  }
  const restaurant = order.restaurant;
  const copy: Record<OrderStatus, {title: string; body: string}> = {
    "Order placed": {title: "Order placed", body: `${restaurant} received your order.`},
    "Accepted": {title: "Order accepted", body: `${restaurant} accepted your order. We’re finding the nearest available delivery partner now.`},
    "Preparing": {title: "Your food is being prepared", body: order.riderId ? `${restaurant} is cooking while your delivery partner heads to the restaurant.` : `${restaurant} is cooking while we find your delivery partner.`},
    "Ready for pickup": {title: "Order is ready for pickup", body: order.riderId ? "Your delivery partner can now collect it from the restaurant." : "Your food is ready while we finish assigning the nearest delivery partner."},
    "Assigned": {title: "Delivery partner assigned", body: "Your delivery partner is heading to the restaurant."},
    "Handed to rider": {title: "Order picked up", body: "Your order has left the restaurant."},
    "Out for delivery": {title: "On the way", body: "Track your delivery partner live in Scraveit."},
    "Near you": {title: "Delivery partner is near you", body: "Please be ready to receive your order."},
    "Arrived": {title: "Delivery partner is at your doorstep", body: "Share the delivery OTP only after receiving the order."},
    "Delivered": {title: "Order delivered", body: "Enjoy your meal. You can now rate the restaurant and delivery partner."},
    "Cancelled": {title: "Order cancelled", body: "Open Scraveit for the cancellation details."},
  };
  // Cancelled while the delivery partner had the food (founder 22 Nov 2026).
  const plan = status === "Cancelled" ? afterPickupPlan(order) : null;
  if (plan) {
    return {
      title: "Order cancelled",
      body: plan.charged ? "It was cancelled after pickup, so this order is not refunded." :
        plan.blockCod ? "It was cancelled after pickup. Cash on delivery is now off for your account." :
          plan.refund ? "It was cancelled because of a delivery problem. Your money will be refunded." :
            "It was cancelled because of a delivery problem.",
    };
  }
  // The customer cancelled after the restaurant accepted, before pickup: the 100% fee (domain/customerCancel.ts).
  if (status === "Cancelled" && cancelledWithFeeBeforePickup(order)) {
    return {
      title: "Order cancelled",
      body: order.paymentMethod === "cod" ?
        "You cancelled after the restaurant accepted. Cash on delivery is now off for your account." :
        "You cancelled after the restaurant accepted, so the 100% cancellation fee applies and it is not refunded.",
    };
  }
  return copy[status];
}

export async function notifyRestaurantNewOrder(order: SavrivoOrder): Promise<void> {
  // The Restaurant, Grocery, Dairy and Health care apps all register as "restaurant";
  // the store type tells each app to ring only for its own kind of store.
  const restaurant = await restaurantRef(firestoreDb, order.restaurantId).get().catch(() => null);
  const storeType = storeTypeOf((restaurant?.exists ? restaurant.data() as {storeType?: unknown} | undefined : undefined)?.storeType);
  const message = buildRestaurantNewOrderMessage(order);
  message.data = {...message.data, storeType};
  const result = await enqueueAndAttempt({
    eventType: "RESTAURANT_NEW_ORDER",
    aggregateType: "order",
    aggregateId: order.id,
    deduplicationKey: `restaurant-new-order:${order.id}`,
    recipient: {kind: "restaurant", id: order.restaurantId, app: "restaurant"},
    message: storedMessage(message),
  });
  logger.info("NEW_ORDER_PUSH_RESULT", {
    orderId: order.id,
    restaurantId: order.restaurantId,
    outboxEventId: result.eventId,
    outcome: result.outcome,
  });
}

/** "Your order is getting late": the store app says it even when it is closed (every minute until Order ready). */
export async function notifyRestaurantOrderLate(order: SavrivoOrder, reminder: number): Promise<void> {
  const restaurant = await restaurantRef(firestoreDb, order.restaurantId).get().catch(() => null);
  const storeType = storeTypeOf((restaurant?.exists ? restaurant.data() as {storeType?: unknown} | undefined : undefined)?.storeType);
  const tail = String(order.id).slice(-4);
  await enqueueAndAttempt({
    eventType: "RESTAURANT_ORDER_LATE",
    aggregateType: "order",
    aggregateId: order.id,
    deduplicationKey: `restaurant-order-late:${order.id}:${reminder}`,
    recipient: {kind: "restaurant", id: order.restaurantId, app: "restaurant"},
    message: storedMessage({
      data: {
        type: "RESTAURANT_ORDER_LATE", orderId: order.id, restaurantId: order.restaurantId, storeType,
        title: `Order #${tail} is getting late`, body: "Tap Order ready when it is packed.",
      },
      // Data only, so the app plays the voice itself; stale after a minute (the next one is coming).
      android: {priority: "high", ttl: 60_000},
    }),
  });
}

export async function stopRestaurantAlarm(order: SavrivoOrder): Promise<void> {
  const result = await enqueueAndAttempt({
    eventType: "RESTAURANT_STOP_ORDER_ALARM",
    aggregateType: "order",
    aggregateId: order.id,
    deduplicationKey: `restaurant-stop-order-alarm:${order.id}`,
    recipient: {kind: "restaurant", id: order.restaurantId, app: "restaurant"},
    message: storedMessage(buildStopRestaurantAlarmMessage(order.id, order.updatedAt)),
  });
  logger.info("STOP_ORDER_ALARM_PUSH_RESULT", {
    orderId: order.id,
    restaurantId: order.restaurantId,
    outboxEventId: result.eventId,
    outcome: result.outcome,
  });
}

/** "Order #1234 cancelled" to the store or to the assigned delivery partner. Sent once each. */
export async function notifyOrderCancelled(
  order: SavrivoOrder,
  audience: "restaurant" | "partner",
  customerCause: boolean,
  partnerPayPaise = 0,
  afterPickup?: {rescue: boolean},
): Promise<void> {
  const riderId = String(order.riderId ?? "");
  if (audience === "partner" && !riderId) return;
  const result = await enqueueAndAttempt({
    eventType: audience === "restaurant" ? "RESTAURANT_ORDER_CANCELLED" : "RIDER_ORDER_CANCELLED",
    aggregateType: "order",
    aggregateId: order.id,
    deduplicationKey: `${audience}-order-cancelled:${order.id}`,
    recipient: audience === "restaurant" ?
      {kind: "restaurant", id: order.restaurantId, app: "restaurant"} :
      {kind: "rider", id: riderId, app: "rider"},
    message: storedMessage(buildOrderCancelledNotice({order, audience, customerCause, partnerPayPaise, ...(afterPickup ? {afterPickup} : {})})),
  });
  logger.info("ORDER_CANCELLED_NOTICE", {orderId: order.id, audience, outboxEventId: result.eventId, outcome: result.outcome});
}

/**
 * Food Rescue (services/foodRescue.ts): a customer near the delivery partner hears about food at
 * half price. It stops showing on the phone when the offer ends.
 */
export async function notifyCustomerFoodRescue(input: {
  uid: string; rescueId: string; title: string; body: string; endsAt: number;
}): Promise<void> {
  const ttl = Math.max(60_000, Math.round(input.endsAt - Date.now()));
  await enqueueAndAttempt({
    eventType: "CUSTOMER_FOOD_RESCUE",
    aggregateType: "food_rescue",
    aggregateId: input.rescueId,
    deduplicationKey: `customer-food-rescue:${input.rescueId}:${input.uid}`,
    recipient: {kind: "user", id: input.uid, app: "customer"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "FOOD_RESCUE", route: "home", rescueId: input.rescueId},
      android: {priority: "high", ttl, notification: {channelId: "customer_reminders", sound: "default"}},
      apns: {
        headers: {"apns-priority": "10", "apns-expiration": String(Math.floor(input.endsAt / 1000))},
        payload: {aps: {sound: "default"}},
      },
    }),
  });
}

/** Food Rescue news for the delivery partner who has the food: a new drop, or the food is theirs. */
export async function notifyPartnerFoodRescue(input: {
  riderId: string; key: string; orderId: string; restaurantId: string; status: string; title: string; body: string;
}): Promise<void> {
  const result = await enqueueAndAttempt({
    eventType: "RIDER_FOOD_RESCUE",
    aggregateType: "order",
    aggregateId: input.orderId,
    deduplicationKey: `rider-food-rescue:${input.key}`,
    recipient: {kind: "rider", id: input.riderId, app: "rider"},
    // Type ORDER_STATUS: every Delivery Partner app build already shows it.
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "ORDER_STATUS", orderId: input.orderId, status: input.status, restaurantId: input.restaurantId,
        title: input.title, body: input.body},
      android: {priority: "high", notification: {channelId: "savrivo_order_status", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
  logger.info("RIDER_FOOD_RESCUE_PUSH", {orderId: input.orderId, key: input.key, outboxEventId: result.eventId, outcome: result.outcome});
}

export async function notifyCustomerStatus(order: SavrivoOrder): Promise<void> {
  const copy = statusCopy(order);
  await enqueueAndAttempt({
    eventType: "CUSTOMER_ORDER_STATUS",
    aggregateType: "order",
    aggregateId: order.id,
    deduplicationKey: `customer-status:${order.id}:${order.status}`,
    recipient: {kind: "user", id: order.customerId, app: "customer"},
    message: storedMessage({
      notification: copy,
      data: {type: "ORDER_STATUS", orderId: order.id, status: order.status, restaurantId: order.restaurantId},
      android: {priority: "high", notification: {channelId: "customer_orders", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

/** Campus orders: the delivery partner has reached the customer's college or hospital. Sent once. */
export async function notifyCustomerAtCampus(order: SavrivoOrder, campusName: string): Promise<void> {
  const place = campusName ? campusName.slice(0, 60) : "your campus";
  await enqueueAndAttempt({
    eventType: "CUSTOMER_PARTNER_AT_CAMPUS",
    aggregateType: "order",
    aggregateId: order.id,
    deduplicationKey: `customer-at-campus:${order.id}`,
    recipient: {kind: "user", id: order.customerId, app: "customer"},
    message: storedMessage({
      notification: {
        title: "Your delivery partner is near your campus",
        body: `They have reached ${place}. Keep your phone close, they may call you.`,
      },
      data: {type: "ORDER_STATUS", orderId: order.id, status: order.status, restaurantId: order.restaurantId},
      android: {priority: "high", notification: {channelId: "customer_orders", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

export async function notifyCustomerRiderAssigned(order: SavrivoOrder): Promise<void> {
  await enqueueAndAttempt({
    eventType: "CUSTOMER_RIDER_ASSIGNED",
    aggregateType: "order",
    aggregateId: order.id,
    deduplicationKey: `customer-rider-assigned:${order.id}`,
    recipient: {kind: "user", id: order.customerId, app: "customer"},
    message: storedMessage({
      notification: {
        title: "Delivery partner assigned",
        body: `${order.riderName ?? "A Scraveit Partner"} accepted your delivery. Open Scraveit for details.`,
      },
      data: {type: "RIDER_ASSIGNED", orderId: order.id, status: "Assigned", restaurantId: order.restaurantId},
      android: {priority: "high", notification: {channelId: "customer_orders", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

export async function notifyRiderOffer(riderId: string, order: SavrivoOrder, expiresAt: number): Promise<void> {
  const result = await enqueueAndAttempt({
    eventType: "RIDER_ORDER_OFFER",
    aggregateType: "order",
    aggregateId: order.id,
    deduplicationKey: `rider-offer:${order.id}:${riderId}:${expiresAt}`,
    recipient: {kind: "rider", id: riderId, app: "rider"},
    message: storedMessage(buildRiderOfferMessage(order, expiresAt)),
  });
  logger.info("RIDER_OFFER_PUSH_RESULT", {orderId: order.id, riderId, outboxEventId: result.eventId, outcome: result.outcome});
}

export async function notifyRiderWake(riderId: string, now = Date.now()): Promise<void> {
  const result = await enqueueAndAttempt({
    eventType: "RIDER_WAKE_TRACKING",
    aggregateType: "rider",
    aggregateId: riderId,
    // At most one wake per rider every 5 minutes, however many orders come in.
    deduplicationKey: `rider-wake:${riderId}:${Math.floor(now / 300_000)}`,
    recipient: {kind: "rider", id: riderId, app: "rider"},
    message: storedMessage(buildRiderWakeMessage()),
  });
  logger.info("RIDER_WAKE_PUSH_RESULT", {riderId, outboxEventId: result.eventId, outcome: result.outcome});
}

export async function stopRiderOffers(riderIds: string[], orderId: string, assignedRiderId: string): Promise<void> {
  const unique = [...new Set(riderIds.filter(Boolean))];
  const results = await Promise.all(unique.map((riderId) => enqueueAndAttempt({
    eventType: "RIDER_REMOVE_ORDER_OFFER",
    aggregateType: "order",
    aggregateId: orderId,
    deduplicationKey: `rider-remove-offer:${orderId}:${riderId}:${assignedRiderId}`,
    recipient: {kind: "rider", id: riderId, app: "rider"},
    message: storedMessage(buildRemoveRiderOfferMessage(orderId, assignedRiderId)),
  })));
  logger.info("RIDER_OFFER_STOP_RESULT", {
    orderId,
    assignedRiderId,
    riderCount: unique.length,
    outcomes: results.reduce<Record<string, number>>((counts, result) => {
      counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
      return counts;
    }, {}),
  });
}

export async function notifyRiderRewardUpdate(input: {
  riderId: string;
  eventType: string;
  deduplicationKey: string;
  title: string;
  body: string;
  campaignId?: string;
  periodKey?: string;
  data?: Record<string, string>;
}): Promise<void> {
  const result = await enqueueAndAttempt({
    eventType: input.eventType,
    aggregateType: "rider_reward",
    aggregateId: input.campaignId ?? input.riderId,
    deduplicationKey: input.deduplicationKey,
    recipient: {kind: "rider", id: input.riderId, app: "rider"},
    message: storedMessage({
      notification: {
        title: input.title,
        body: input.body,
      },
      data: {
        type: "RIDER_REWARD_UPDATE",
        riderId: input.riderId,
        campaignId: input.campaignId ?? "",
        periodKey: input.periodKey ?? "",
        ...(input.data ?? {}),
      },
      // The Rider app has no "rider_rewards" channel, so Android played these on its default
      // channel, the delivery-offer alarm. "Order status" exists in every Rider build and uses
      // the normal notification sound.
      android: {priority: "high", notification: {channelId: "savrivo_order_status", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
  logger.info("RIDER_REWARD_PUSH_RESULT", {
    riderId: input.riderId,
    campaignId: input.campaignId ?? "",
    outboxEventId: result.eventId,
    outcome: result.outcome,
  });
}


/** A Google Maps usage warning to one admin's devices (admin app). */
export async function notifyAdminMapsAlert(input: {uid: string; deduplicationKey: string; title: string; body: string}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "ADMIN_MAPS_USAGE_ALERT",
    aggregateType: "maps_usage",
    aggregateId: input.deduplicationKey,
    deduplicationKey: `${input.deduplicationKey}:${input.uid}`,
    recipient: {kind: "admin", id: input.uid, app: "admin"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "ADMIN_MAPS_USAGE_ALERT"},
      android: {priority: "high", notification: {channelId: "savrivo_control_orders_v2", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}


/** An urgent to-do for one admin's devices: new application, signed agreement, stuck order. */
export async function notifyAdminTodo(input: {uid: string; key: string; title: string; body: string; route: string}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "ADMIN_TODO",
    aggregateType: "admin_todo",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `admin-todo:${input.key}:${input.uid}`,
    recipient: {kind: "admin", id: input.uid, app: "admin"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "ADMIN_TODO", route: input.route},
      android: {priority: "high", notification: {channelId: "savrivo_control_orders_v2", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

/**
 * A request that rings the admin app until it's opened: rider application,
 * store application, support ticket. Data-only and high priority, so the
 * app's own alarm service starts even when the app is closed.
 */
export async function notifyAdminAlarm(input: {uid: string; key: string; alarmId: string; title: string; body: string; route: string; issuedAt: number}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "ADMIN_ALARM",
    aggregateType: "admin_alarm",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `admin-alarm:${input.key}:${input.uid}`,
    recipient: {kind: "admin", id: input.uid, app: "admin"},
    message: storedMessage({
      data: {type: "ADMIN_ALARM", alarmId: input.alarmId, title: input.title, body: input.body, route: input.route, issuedAt: String(input.issuedAt)},
      android: {priority: "high", ttl: 3_600_000},
      // iPhone: the Admin app's own 29 s alarm sound (older builds without it fall back to the default sound),
      // time-sensitive so it shows during Focus (founder, 21 Nov 2026).
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {alert: {title: input.title, body: input.body}, sound: "admin_alert.caf", "interruption-level": "time-sensitive"}}},
    }),
  });
}

/** Dine-in alerts to everyone running a restaurant (bookings, rounds, waiter calls, bills). */
export async function notifyRestaurantDineIn(input: {restaurantId: string; key: string; title: string; body: string}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "RESTAURANT_DINE_IN",
    aggregateType: "dine_in",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `restaurant-dine-in:${input.key}`,
    recipient: {kind: "restaurant", id: input.restaurantId, app: "restaurant"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "DINE_IN", restaurantId: input.restaurantId},
      android: {priority: "high", notification: {sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

/** To someone who applied to sell on Scraveit: rate confirmed, changes asked for, approved. */
export async function notifyStoreApplicant(input: {uid: string; key: string; title: string; body: string}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "STORE_APPLICATION",
    aggregateType: "store_application",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `store-applicant:${input.key}`,
    recipient: {kind: "user", id: input.uid, app: "restaurant"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "STORE_APPLICATION"},
      android: {priority: "high", notification: {channelId: "savrivo_order_status", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

/** Friends & chat: a new message, friend request or parent decision to one customer. */
export async function notifyUserChat(input: {uid: string; key: string; title: string; body: string; data?: Record<string, string>}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "CUSTOMER_CHAT",
    aggregateType: "chat",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `customer-chat:${input.key}:${input.uid}`,
    recipient: {kind: "user", id: input.uid, app: "customer"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "CHAT", ...(input.data ?? {})},
      android: {priority: "high", notification: {channelId: "customer_orders", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

/**
 * A chat message locked end to end. Data-only, so the phone's own code runs, unlocks it with its key
 * and shows what it says. FCM allows 4 KB of data: a long message travels without its text and
 * shows as "New message".
 */
export async function notifyChatSealed(input: {uid: string; key: string; fromName: string; pairId: string; messageId: string; from: string;
  sealed: {v: 1 | 2; iv: string; ct: string; spk: string; rpk?: string; epk?: string; w?: Array<{k: string; iv: string; c: string}>}}): Promise<void> {
  const s = input.sealed;
  // The phone needs the wraps (version 2) or the recipient's key (version 1) to unlock it.
  const lock: Record<string, string> = s.v === 2
    ? {v: "2", epk: s.epk ?? "", w: JSON.stringify(s.w ?? [])}
    : {v: "1", rpk: s.rpk ?? ""};
  await enqueueAndAttempt({
    eventType: "CUSTOMER_CHAT",
    aggregateType: "chat",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `customer-chat:${input.key}:${input.uid}`,
    recipient: {kind: "user", id: input.uid, app: "customer"},
    message: storedMessage({
      data: {
        type: "CHAT", e2e: "1", route: `dm:${input.pairId}`, pairId: input.pairId, messageId: input.messageId, from: input.from, to: input.uid,
        fromName: input.fromName.slice(0, 60), iv: s.iv, ct: s.ct.length <= 2400 ? s.ct : "", spk: s.spk, ...lock,
      },
      android: {priority: "high"},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {alert: {title: input.fromName.slice(0, 60), body: "New message"}, sound: "default", mutableContent: true}}},
    }),
  });
}

/**
 * A friend is calling. Data-only and high priority, so the app's own code always runs and shows a
 * ringing call notification with Answer/Decline, even when the app is closed. Useless after 40 s.
 */
export async function notifyCallIncoming(input: {uid: string; callId: string; pairId: string; kind: "audio" | "video"; fromName: string; ringKey?: string}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "CUSTOMER_CALL",
    aggregateType: "call",
    aggregateId: input.callId.slice(0, 120),
    deduplicationKey: `customer-call:${input.callId}:ring`,
    recipient: {kind: "user", id: input.uid, app: "customer"},
    message: storedMessage({
      data: {type: "CALL_INCOMING", callId: input.callId, pairId: input.pairId, kind: input.kind, fromName: input.fromName.slice(0, 60), ...(input.ringKey ? {ringKey: input.ringKey} : {})},
      android: {priority: "high", ttl: 40_000},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

/** The call stopped ringing: the phone removes the ringing notification (and shows "Missed call" if it was missed). */
export async function notifyCallEnded(input: {uid: string; callId: string; pairId: string; missed: boolean; kind: "audio" | "video"; fromName: string}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "CUSTOMER_CALL",
    aggregateType: "call",
    aggregateId: input.callId.slice(0, 120),
    deduplicationKey: `customer-call:${input.callId}:end`,
    recipient: {kind: "user", id: input.uid, app: "customer"},
    message: storedMessage({
      data: {type: "CALL_ENDED", callId: input.callId, pairId: input.pairId, missed: input.missed ? "1" : "0", kind: input.kind, fromName: input.fromName.slice(0, 60), route: `dm:${input.pairId}`},
      android: {priority: "high"},
      apns: {headers: {"apns-priority": "5"}, payload: {aps: {}}},
    }),
  });
}

/** A reminder about items left in the cart (cartReminders.ts). Offers channel, so it can be muted in phone settings. */
export async function notifyCartReminder(input: {uid: string; key: string; title: string; body: string}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "CUSTOMER_CART_REMINDER",
    aggregateType: "cart_reminder",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `customer-cart:${input.key}`,
    recipient: {kind: "user", id: input.uid, app: "customer"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "CART_REMINDER", route: "cart"},
      android: {priority: "normal", notification: {channelId: "customer_reminders", sound: "default"}},
      apns: {headers: {"apns-priority": "5"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

/** A birthday greeting (birthdays.ts). Opens the home screen, which shows the birthday header. */
export async function notifyBirthday(input: {uid: string; key: string; title: string; body: string}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "CUSTOMER_BIRTHDAY",
    aggregateType: "birthday",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `customer-birthday:${input.key}`,
    recipient: {kind: "user", id: input.uid, app: "customer"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "BIRTHDAY", route: "home"},
      android: {priority: "normal", notification: {channelId: "customer_reminders", sound: "default"}},
      apns: {headers: {"apns-priority": "5"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

/** A breakfast, lunch or dinner idea for one customer (mealSuggestions.ts). */
export async function notifyMealSuggestion(input: {uid: string; key: string; title: string; body: string}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "CUSTOMER_MEAL_SUGGESTION",
    aggregateType: "meal_suggestion",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `customer-meal:${input.key}`,
    recipient: {kind: "user", id: input.uid, app: "customer"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "MEAL_SUGGESTION", route: "home"},
      android: {priority: "normal", notification: {channelId: "customer_reminders", sound: "default"}},
      apns: {headers: {"apns-priority": "5"}, payload: {aps: {sound: "default"}}},
    }),
  });
}

/** Dine-in updates to one customer (booking answers, reminders, food served, bill settled). */
export async function notifyUserDineIn(input: {uid: string; key: string; title: string; body: string; data?: Record<string, string>}): Promise<void> {
  await enqueueAndAttempt({
    eventType: "CUSTOMER_DINE_IN",
    aggregateType: "dine_in",
    aggregateId: input.key.slice(0, 120),
    deduplicationKey: `customer-dine-in:${input.key}:${input.uid}`,
    recipient: {kind: "user", id: input.uid, app: "customer"},
    message: storedMessage({
      notification: {title: input.title, body: input.body},
      data: {type: "DINE_IN", ...(input.data ?? {})},
      android: {priority: "high", notification: {channelId: "customer_orders", sound: "default"}},
      apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
    }),
  });
}
