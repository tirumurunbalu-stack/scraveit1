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

export function restaurantAlarmId(orderId: string): string {
  return `order:${orderId}`;
}

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
  const title = "New Savrivo order";
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
      payload: {aps: {alert: {title, body}, sound: "new_order_alarm.caf", category: "NEW_ORDER"}},
    },
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
    apns: {
      headers: {"apns-priority": "10", "apns-collapse-id": collapseKey},
      payload: {aps: {contentAvailable: true}},
    },
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
      payload: {aps: {alert: {title, body}, sound: "rider_offer.caf", category: "RIDER_OFFER"}},
    },
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
    apns: {
      headers: {"apns-priority": "10", "apns-collapse-id": collapseKey},
      payload: {aps: {contentAvailable: true}},
    },
  };
}
