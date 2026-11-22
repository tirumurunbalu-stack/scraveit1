import type {MulticastMessage} from "firebase-admin/messaging";
import type {SavrivoOrder} from "../types";

export type TokenlessMulticastMessage = Omit<MulticastMessage, "tokens">;

type RestaurantNewOrder = Pick<
  SavrivoOrder,
  "id" | "customerId" | "restaurantId" | "items" | "total" | "createdAt"
>;

type RiderOfferOrder = Pick<
  SavrivoOrder,
  "id" | "customerId" | "restaurantId" | "restaurant" | "pricing"
>;

const RESTAURANT_ALARM_TTL_MS = 15 * 60 * 1000;
const CONTROL_MESSAGE_TTL_MS = 5 * 60 * 1000;

export interface CustomerBroadcastPayload {
  id: string;
  title: string;
  message: string;
  deepLink?: string;
  restaurantId?: string;
  scheduledAt: number;
}

/**
 * Rendered (not data-only) so Android's FCM SDK can auto-display it via the
 * customer_promotions channel while the app is backgrounded; the app's own
 * onMessageReceived only has to build one manually when it is foregrounded.
 */
export function buildCustomerBroadcastMessage(broadcast: CustomerBroadcastPayload): TokenlessMulticastMessage {
  return {
    notification: {title: broadcast.title, body: broadcast.message},
    data: {
      type: "CUSTOMER_BROADCAST",
      broadcastId: broadcast.id,
      deepLink: broadcast.deepLink || "home",
      ...(broadcast.restaurantId ? {restaurantId: broadcast.restaurantId} : {}),
    },
    android: {priority: "high", notification: {channelId: "customer_promotions"}},
    apns: {headers: {"apns-priority": "10"}, payload: {aps: {}}},
  };
}

export function restaurantAlarmId(orderId: string): string {
  return `order:${orderId}`;
}

/**
 * New-order and offer alerts are "time-sensitive" on iPhones so they still show and sound during
 * Focus / Do Not Disturb (founder, 21 Nov 2026). Needs the time-sensitive entitlement in the app;
 * older app builds simply treat it as a normal alert.
 */
export function restaurantOrderCollapseKey(orderId: string): string {
  return `restaurant-order-${orderId}`.slice(0, 64);
}

export function riderOfferId(orderId: string): string {
  return `rider-offer:${orderId}`;
}

export function riderOfferCollapseKey(orderId: string): string {
  return `rider-offer-${orderId}`.slice(0, 64);
}

/**
 * Android deliberately receives a data-only message. A top-level notification
 * payload lets Android render the message without invoking onMessageReceived,
 * which would make the app-owned acknowledgement alarm unreliable.
 */
export function buildRestaurantNewOrderMessage(order: RestaurantNewOrder): TokenlessMulticastMessage {
  const title = "New Scraveit order";
  const body = `${order.items.length} item(s) · ₹${order.total}`;
  const collapseKey = restaurantOrderCollapseKey(order.id);

  return {
    data: {
      type: "RESTAURANT_NEW_ORDER",
      orderId: order.id,
      customerId: order.customerId,
      restaurantId: order.restaurantId,
      alarmId: restaurantAlarmId(order.id),
      eventId: `NEW_ORDER:${order.id}`,
      eventAt: String(order.createdAt),
      status: "Order placed",
      title,
      body,
      requiresAcknowledgement: "true",
    },
    android: {
      priority: "high",
      collapseKey,
      ttl: RESTAURANT_ALARM_TTL_MS,
    },
    apns: {
      headers: {"apns-priority": "10", "apns-collapse-id": collapseKey},
      payload: {aps: {alert: {title, body}, sound: "new_order_alarm.caf", category: "NEW_ORDER", "interruption-level": "time-sensitive"}},
    },
  };
}

/**
 * iPhones: a push with only content-available is a background push. Apple wants it sent with
 * apns-push-type "background" at priority 5; priority 10 is meant for pushes that alert the user,
 * and APNs may refuse or hold a silent push sent at 10. Android is unaffected (android block).
 */
function backgroundApns(collapseKey: string): NonNullable<TokenlessMulticastMessage["apns"]> {
  return {
    headers: {"apns-priority": "5", "apns-push-type": "background", "apns-collapse-id": collapseKey},
    payload: {aps: {contentAvailable: true}},
  };
}

export function buildStopRestaurantAlarmMessage(orderId: string, eventAt = Date.now()): TokenlessMulticastMessage {
  const collapseKey = restaurantOrderCollapseKey(orderId);
  return {
    data: {
      type: "STOP_ORDER_ALARM",
      orderId,
      alarmId: restaurantAlarmId(orderId),
      eventId: `STOP_ORDER_ALARM:${orderId}`,
      eventAt: String(eventAt),
      status: "handled",
    },
    android: {priority: "high", collapseKey, ttl: CONTROL_MESSAGE_TTL_MS},
    apns: backgroundApns(collapseKey),
  };
}

/**
 * Android must receive rider offers as high-priority data messages. A top-level
 * notification payload is consumed by Google Play services while the app is in
 * the background, bypassing SavrivoMessagingService and therefore preventing
 * the repeating offer alarm from starting.
 */
export function buildRiderOfferMessage(
  order: RiderOfferOrder,
  expiresAt: number,
  now = Date.now(),
): TokenlessMulticastMessage {
  const title = "Restaurant accepted · delivery offer";
  const body = `${order.restaurant} · ₹${order.pricing.deliveryFee} payout · pickup when ready`;
  const collapseKey = riderOfferCollapseKey(order.id);

  return {
    data: {
      type: "RIDER_ORDER_OFFER",
      orderId: order.id,
      offerId: riderOfferId(order.id),
      customerId: order.customerId,
      restaurantId: order.restaurantId,
      offeredAt: String(now),
      expiresAt: String(expiresAt),
      title,
      body,
    },
    android: {
      priority: "high",
      collapseKey,
      ttl: Math.max(1, expiresAt - now),
    },
    apns: {
      headers: {"apns-priority": "10", "apns-collapse-id": collapseKey},
      payload: {aps: {alert: {title, body}, sound: "rider_offer.caf", category: "RIDER_OFFER", "interruption-level": "time-sensitive"}},
    },
  };
}

/** No alert: this only restarts an Online rider's tracking service on phones that allow it. */
export function buildRiderWakeMessage(): TokenlessMulticastMessage {
  return {
    data: {type: "RIDER_WAKE_TRACKING"},
    android: {priority: "high", ttl: 60_000},
  };
}

export function buildRemoveRiderOfferMessage(
  orderId: string,
  assignedRiderId: string,
): TokenlessMulticastMessage {
  const collapseKey = riderOfferCollapseKey(orderId);
  return {
    data: {
      type: "REMOVE_RIDER_OFFER",
      orderId,
      offerId: riderOfferId(orderId),
      assignedRiderId,
    },
    android: {priority: "high", collapseKey, ttl: CONTROL_MESSAGE_TTL_MS},
    apns: backgroundApns(collapseKey),
  };
}

type CancelNoticeOrder = Pick<SavrivoOrder, "id" | "restaurantId" | "restaurant" | "riderId" | "selfDelivery" |
  "cancelReason" | "cancelledByRole" | "statusBeforeTerminal" | "foodRescue" | "cancellationFee">;

/**
 * Who hears about a cancel (founder 21 Nov 2026: an admin cancel reached only the customer).
 * The store, unless it cancelled itself or never saw the order (an unpaid online order the
 * system dropped). The assigned delivery partner, on any cancel.
 */
export function cancelNoticeTargets(order: CancelNoticeOrder): {restaurant: boolean; partner: boolean} {
  const role = order.cancelledByRole;
  return {
    // A Food Rescue buy never reached the store (it was paid for on the first order).
    restaurant: role !== "staff" && !(role === "system" && order.statusBeforeTerminal === "Order placed") &&
      !order.foodRescue,
    partner: Boolean(String(order.riderId ?? "").trim()) && order.selfDelivery !== true,
  };
}

/**
 * "Order #1234 cancelled" for the store or the delivery partner. Type ORDER_STATUS: every app
 * build already shows it on its "Order status" channel, so no app update is needed.
 */
export function buildOrderCancelledNotice(input: {
  order: CancelNoticeOrder;
  audience: "restaurant" | "partner";
  customerCause: boolean;
  partnerPayPaise?: number;
  /** Cancelled while the partner carried it (domain/afterPickup.ts); rescue = it's now a Food Rescue offer. */
  afterPickup?: {rescue: boolean};
}): TokenlessMulticastMessage {
  const {order} = input;
  const title = `Order #${String(order.id).slice(-4)} cancelled`;
  const reason = String(order.cancelReason ?? "").trim().slice(0, 80);
  const pay = Math.max(0, Math.round(Number(input.partnerPayPaise) || 0));
  const rupees = `₹${pay % 100 ? (pay / 100).toFixed(2) : pay / 100}`;
  const body = input.afterPickup ? (input.audience === "restaurant" ?
    "It was cancelled after pickup. You are paid for this order as if it was delivered." :
    input.afterPickup.rescue ?
      `${order.restaurant}: the customer cancelled.${pay > 0 ? ` You get ${rupees} for the full trip.` : ""} Please wait where you are for up to 15 min. A customer nearby may buy this food.` :
      `${order.restaurant}: cancelled after pickup.${pay > 0 ? ` You get ${rupees} for the full trip.` : ""} The food is yours to keep.`) :
    input.audience === "restaurant" ?
      (input.customerCause ? (Number(order.cancellationFee?.percent) > 0 ?
        // The customer accepted the 100% fee (domain/customerCancel.ts).
        "The customer cancelled it after you accepted. You are paid for this order as if it was delivered. Please don't hand it over." :
        "The customer cancelled it. Please don't prepare or hand it over.") :
        `Scraveit cancelled it${reason ? `: ${reason}` : ""}. Please don't prepare or hand it over.`) :
      pay > 0 ? `${order.restaurant}: cancelled after you reached the restaurant. You get ${rupees}.` :
        `${order.restaurant}: don't pick it up. The order was cancelled.`;
  return {
    notification: {title, body},
    data: {type: "ORDER_STATUS", orderId: order.id, status: "Cancelled", restaurantId: order.restaurantId, title, body},
    android: {priority: "high", notification: {channelId: "savrivo_order_status", sound: "default"}},
    apns: {headers: {"apns-priority": "10"}, payload: {aps: {sound: "default"}}},
  };
}
