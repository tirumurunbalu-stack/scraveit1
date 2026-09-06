import {describe, expect, it} from "vitest";
import {
  buildRemoveRiderOfferMessage,
  buildRestaurantNewOrderMessage,
  buildRiderOfferMessage,
  buildStopRestaurantAlarmMessage,
} from "../src/domain/notificationMessages";
import type {SavrivoOrder} from "../src/types";

const order = {
  id: "SV-ABC123",
  customerId: "customer-1",
  restaurantId: "the-waffle-spot-naidupeta",
  restaurant: "The Waffle Spot",
  items: [{itemId: "classic", quantity: 2}],
  total: 373,
  createdAt: 1_700_000_000_000,
  pricing: {deliveryFee: 39},
} as SavrivoOrder;

describe("restaurant operational FCM messages", () => {
  it("uses a high-priority Android data-only start message with an exact alarm identity", () => {
    const message = buildRestaurantNewOrderMessage(order);

    expect(message.notification).toBeUndefined();
    expect(message.android?.notification).toBeUndefined();
    expect(message.android).toMatchObject({
      priority: "high",
      ttl: 900_000,
      collapseKey: "restaurant-order-SV-ABC123",
    });
    expect(message.data).toEqual({
      type: "RESTAURANT_NEW_ORDER",
      orderId: "SV-ABC123",
      customerId: "customer-1",
      restaurantId: "the-waffle-spot-naidupeta",
      alarmId: "order:SV-ABC123",
      eventId: "NEW_ORDER:SV-ABC123",
      eventAt: "1700000000000",
      status: "Order placed",
      title: "New Savrivo order",
      body: "1 item(s) · ₹373",
      requiresAcknowledgement: "true",
    });
  });

  it("uses the same collapse and alarm IDs for the data-only stop message", () => {
    const start = buildRestaurantNewOrderMessage(order);
    const stop = buildStopRestaurantAlarmMessage(order.id, 1_700_000_001_000);

    expect(stop.notification).toBeUndefined();
    expect(stop.android?.notification).toBeUndefined();
    expect(stop.android).toMatchObject({priority: "high", ttl: 300_000});
    expect(stop.android?.collapseKey).toBe(start.android?.collapseKey);
    expect(stop.apns?.headers?.["apns-collapse-id"]).toBe(start.apns?.headers?.["apns-collapse-id"]);
    expect(stop.data).toEqual({
      type: "STOP_ORDER_ALARM",
      orderId: "SV-ABC123",
      alarmId: "order:SV-ABC123",
      eventId: "STOP_ORDER_ALARM:SV-ABC123",
      eventAt: "1700000001000",
      status: "handled",
    });
  });
});

describe("rider operational FCM messages", () => {
  it("uses high-priority Android data delivery so the closed-app handler can start the alarm", () => {
    const message = buildRiderOfferMessage(order, 1_100_000, 1_000_000);

    expect(message.notification).toBeUndefined();
    expect(message.android?.notification).toBeUndefined();
    expect(message.android).toMatchObject({
      priority: "high",
      ttl: 100_000,
      collapseKey: "rider-offer-SV-ABC123",
    });
    expect(message.data).toEqual({
      type: "RIDER_ORDER_OFFER",
      orderId: "SV-ABC123",
      offerId: "rider-offer:SV-ABC123",
      customerId: "customer-1",
      restaurantId: "the-waffle-spot-naidupeta",
      offeredAt: "1000000",
      expiresAt: "1100000",
      title: "Restaurant accepted · delivery offer",
      body: "The Waffle Spot · ₹39 payout · pickup when ready",
    });
    expect(message.apns?.payload.aps).toMatchObject({
      alert: {
        title: "Restaurant accepted · delivery offer",
        body: "The Waffle Spot · ₹39 payout · pickup when ready",
      },
      sound: "rider_offer.caf",
      category: "RIDER_OFFER",
    });
    expect(buildRiderOfferMessage(order, 999_999, 1_000_000).android?.ttl).toBe(1);
  });

  it("removes the exact offer and supersedes a pending offer with the same collapse key", () => {
    const offer = buildRiderOfferMessage(order, 1_100_000, 1_000_000);
    const remove = buildRemoveRiderOfferMessage(order.id, "rider-2");

    expect(remove.notification).toBeUndefined();
    expect(remove.android?.notification).toBeUndefined();
    expect(remove.android).toMatchObject({priority: "high", ttl: 300_000});
    expect(remove.android?.collapseKey).toBe(offer.android?.collapseKey);
    expect(remove.apns?.headers?.["apns-collapse-id"]).toBe(offer.apns?.headers?.["apns-collapse-id"]);
    expect(remove.data).toEqual({
      type: "REMOVE_RIDER_OFFER",
      orderId: "SV-ABC123",
      offerId: "rider-offer:SV-ABC123",
      assignedRiderId: "rider-2",
    });
  });
});
