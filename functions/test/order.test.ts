import {describe, expect, it} from "vitest";
import {
  buildPricing,
  buildOrderTransitionCandidate,
  canTransition,
  deterministicOrderId,
  haversineKm,
  priceCart,
  rankRiders,
} from "../src/domain/order";
import type {SavrivoOrder, StatusEvent} from "../src/types";

describe("order lifecycle", () => {
  it("allows only explicit role-owned transitions", () => {
    expect(canTransition("Order placed", "Accepted", "staff")).toBe(true);
    expect(canTransition("Order placed", "Delivered", "staff")).toBe(false);
    expect(canTransition("Ready for pickup", "Assigned", "rider")).toBe(true);
    expect(canTransition("Ready for pickup", "Assigned", "owner")).toBe(false);
    expect(canTransition("Out for delivery", "Near you", "rider")).toBe(false);
    expect(canTransition("Out for delivery", "Near you", "system")).toBe(true);
    expect(canTransition("Near you", "Arrived", "rider")).toBe(false);
    expect(canTransition("Near you", "Arrived", "system")).toBe(true);
    expect(canTransition("Arrived", "Delivered", "rider")).toBe(true);
    expect(canTransition("Delivered", "Cancelled", "owner")).toBe(false);
  });

  it("derives stable, customer-scoped order IDs", () => {
    const one = deterministicOrderId("customer-a", "0123456789abcdef");
    expect(one).toBe(deterministicOrderId("customer-a", "0123456789abcdef"));
    expect(one).not.toBe(deterministicOrderId("customer-b", "0123456789abcdef"));
    expect(one).toMatch(/^SV-[A-F0-9]{18}$/);
  });

  it("does not abort when RTDB first supplies a provisional null snapshot", () => {
    const cached = {
      id: "SV-ORDER-1",
      customerId: "customer-1",
      restaurantId: "restaurant-1",
      createdAt: 100,
      updatedAt: 100,
      status: "Order placed",
      statusHistory: {},
    } as SavrivoOrder;
    const event: StatusEvent = {
      status: "Accepted", at: 200, actorId: "staff-1", actorRole: "staff",
    };
    const next = buildOrderTransitionCandidate(null, cached, {
      toStatus: "Accepted", actorRole: "staff", eventId: "event-1", event, now: 200,
    });
    expect(next).toMatchObject({status: "Accepted", updatedAt: 200});
    expect(next?.statusHistory["event-1"]).toEqual(event);
  });

  it("still rejects a genuinely stale or different canonical order", () => {
    const cached = {
      id: "SV-ORDER-1",
      customerId: "customer-1",
      restaurantId: "restaurant-1",
      createdAt: 100,
      updatedAt: 100,
      status: "Order placed",
      statusHistory: {},
    } as SavrivoOrder;
    const changed = {...cached, status: "Accepted" as const, updatedAt: 150};
    const event: StatusEvent = {
      status: "Cancelled", at: 200, actorId: "staff-1", actorRole: "staff",
    };
    expect(buildOrderTransitionCandidate(changed, cached, {
      toStatus: "Cancelled", actorRole: "staff", eventId: "event-1", event, now: 200,
    })).toBeUndefined();
  });
});

describe("server catalog pricing", () => {
  const menu = {
    waffle: {
      id: "waffle",
      name: "Classic Waffle",
      price: 100,
      available: true,
      variants: [{id: "large", name: "Large", price: 25}],
      addOns: [{id: "icecream", name: "Ice cream", price: 30}],
      diet: "veg",
    },
  };

  it("ignores client prices and derives each amount from the catalog", () => {
    const result = priceCart([{
      itemId: "waffle", quantity: 2, variantId: "large", addOnIds: ["icecream"], note: "less sweet",
    }], menu);
    expect(result.subtotal).toBe(310);
    expect(result.items[0]).toMatchObject({price: 100, variantPrice: 25, addOnTotal: 30, quantity: 2});
  });

  it("rejects duplicate or unavailable customizations", () => {
    expect(() => priceCart([{
      itemId: "waffle", quantity: 1, variantId: "large", addOnIds: ["icecream", "icecream"],
    }], menu)).toThrow("DUPLICATE_ADD_ON");
    expect(() => priceCart([{itemId: "missing", quantity: 1, addOnIds: []}], menu)).toThrow("ITEM_UNAVAILABLE");
  });

  it("produces a reconciled total with tax and fees", () => {
    const result = buildPricing({
      subtotal: 310, discount: 31, deliveryFee: 29, platformFee: 15,
      taxRate: 5, tip: 20, smallOrderThreshold: 500, smallOrderFee: 10,
    });
    expect(result.pricing.tax).toBe(13.95);
    expect(result.total).toBe(366.95);
    expect(result.pricing.source).toBe("catalog_snapshot_v3");
  });
});

describe("rider ranking", () => {
  it("uses distance first, with current load as a penalty", () => {
    const ranked = rankRiders([
      {riderId: "near-busy", riderName: "A", distanceKm: 0.5, activeLoad: 1},
      {riderId: "near-free", riderName: "B", distanceKm: 0.8, activeLoad: 0},
      {riderId: "far-free", riderName: "C", distanceKm: 1.5, activeLoad: 0},
    ]);
    expect(ranked.map((entry) => entry.riderId)).toEqual(["near-free", "far-free", "near-busy"]);
  });

  it("calculates a realistic short distance", () => {
    const km = haversineKm({lat: 13.9018832, lng: 79.8877264}, {lat: 13.906, lng: 79.89});
    expect(km).toBeGreaterThan(0.4);
    expect(km).toBeLessThan(1);
  });
});
