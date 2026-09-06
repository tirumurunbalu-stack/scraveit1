import {describe, expect, it} from "vitest";
import {buildRiderJobProjection} from "../src/domain/riderJob";
import type {SavrivoOrder} from "../src/types";

function order(status: SavrivoOrder["status"]): SavrivoOrder {
  return {
    id: "SV-JOB",
    customerId: "customer-1",
    customerName: "Private Customer",
    customerPhone: "+919999999999",
    restaurantId: "restaurant-1",
    restaurant: "The Waffle Spot",
    restaurantLocation: {address: "Restaurant address", lat: 13.9, lng: 79.88},
    address: {
      id: "home", label: "Home", area: "Naidupeta", address: "Exact private address",
      phone: "+918888888888", source: "gps", updatedAt: 1, lat: 13.91, lng: 79.89,
    },
    items: [{itemId: "waffle", name: "Secret menu item", quantity: 1, price: 100, variant: "", variantPrice: 0, addOns: [], addOnTotal: 0, note: "", diet: "veg"}],
    pricing: {deliveryFee: 39},
    total: 139,
    paymentMethod: "cod",
    instructions: "Ring bell",
    contactless: false,
    etaMax: 30,
    createdAt: 1_000,
    updatedAt: 2_000,
    status,
    riderId: "rider-1",
    statusHistory: {assigned: {status: "Assigned", at: 1_500, actorId: "rider-1", actorRole: "rider"}},
  } as SavrivoOrder;
}

describe("rider job privacy projection", () => {
  it.each(["Accepted", "Preparing", "Ready for pickup", "Assigned"] as const)(
    "keeps exact customer and order details private while %s",
    (status) => {
      const projection = buildRiderJobProjection(order(status));
      expect(projection).toMatchObject({
        approximateDropZone: "Naidupeta",
        itemCount: 1,
        orderStatus: "Assigned",
        riderId: "rider-1",
      });
      expect(projection).not.toHaveProperty("customerName");
      expect(projection).not.toHaveProperty("address");
      expect(projection).not.toHaveProperty("items");
      expect(projection).not.toHaveProperty("paymentMethod");
      expect(projection).not.toHaveProperty("total");
      expect(projection).not.toHaveProperty("pricing");
      expect(projection).not.toHaveProperty("customerPhone");
      expect(JSON.stringify(projection)).not.toContain("Exact private address");
      expect(JSON.stringify(projection)).not.toContain("13.91");
      expect(JSON.stringify(projection)).not.toContain("79.89");
      expect(JSON.stringify(projection)).not.toContain("Secret menu item");
      expect(JSON.stringify(projection)).not.toContain("9999999999");
      expect(JSON.stringify(projection)).not.toContain("8888888888");
    },
  );

  it.each(["Accepted", "Preparing", "Ready for pickup", "Assigned"] as const)(
    "preserves confirmed restaurant arrival while the same assignment is %s",
    (status) => {
      expect(buildRiderJobProjection(order(status), {
        orderId: "SV-JOB",
        riderId: "rider-1",
        phase: "at_restaurant",
        arrivedRestaurantAt: 1_900,
      })).toMatchObject({phase: "at_restaurant", arrivedRestaurantAt: 1_900});
    },
  );

  it("does not inherit phase from another rider or order", () => {
    expect(buildRiderJobProjection(order("Assigned"), {
      orderId: "SV-JOB",
      riderId: "rider-2",
      phase: "at_restaurant",
    })).toMatchObject({phase: "pickup"});
    expect(buildRiderJobProjection(order("Assigned"), {
      orderId: "SV-OTHER",
      riderId: "rider-1",
      phase: "delivery",
    })).toMatchObject({phase: "pickup"});
  });

  it("never regresses a same-assignment transit phase on a stale rebuild", () => {
    expect(buildRiderJobProjection(order("Preparing"), {
      orderId: "SV-JOB",
      riderId: "rider-1",
      phase: "delivery",
    })).toMatchObject({phase: "delivery"});
    expect(buildRiderJobProjection(order("Ready for pickup"), {
      orderId: "SV-JOB",
      riderId: "rider-1",
      phase: "arrived",
    })).toMatchObject({phase: "arrived"});
    expect(buildRiderJobProjection(order("Out for delivery"), {
      orderId: "SV-JOB",
      riderId: "rider-1",
      phase: "at_restaurant",
    })).toMatchObject({phase: "delivery"});
  });

  it("reveals delivery-required fields, but never a raw phone, after handover", () => {
    const handedOver = order("Handed to rider");
    handedOver.pricing.tip = 20;
    handedOver.contactProxy = "+911234567890";
    const projection = buildRiderJobProjection(handedOver, {
      postDeliveryTip: 50,
      pricing: {postDeliveryTip: 50},
    });
    expect(projection).toMatchObject({
      customerName: "Private Customer",
      address: {address: "Exact private address", lat: 13.91, lng: 79.89},
      items: [{name: "Secret menu item", quantity: 1}],
      instructions: "Ring bell",
      total: 139,
      paymentMethod: "cod",
      pricing: {tip: 20},
      contactProxy: "+911234567890",
      otpRequired: true,
      phase: "at_restaurant",
    });
    expect(projection).not.toHaveProperty("customerPhone");
    expect(projection).not.toHaveProperty("postDeliveryTip");
    expect(projection.pricing).not.toHaveProperty("postDeliveryTip");
    expect(JSON.stringify(projection)).not.toContain("9999999999");
    expect(JSON.stringify(projection)).not.toContain("8888888888");
  });

  it("redacts exact drop details again when the job is terminal", () => {
    const projection = buildRiderJobProjection(order("Delivered"));
    expect(projection).toMatchObject({status: "completed", phase: "complete"});
    expect(projection).not.toHaveProperty("address");
    expect(projection).not.toHaveProperty("items");
    expect(projection).not.toHaveProperty("customerName");
    expect(projection).not.toHaveProperty("customerPhone");
  });
});
