import {describe, expect, it} from "vitest";
import {
  buildOperationalOrderProjection,
  shouldApplyOperationalOrderProjection,
} from "../src/domain/operationalOrders";
import type {SavrivoOrder} from "../src/types";

function order(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: "order-1",
    schemaVersion: 3,
    idempotencyKey: "key-1",
    customerId: "customer-1",
    customerName: "Private Customer",
    customerPhone: "9999999999",
    restaurantId: "restaurant-1",
    restaurant: "Restaurant One",
    restaurantLocation: {address: "Private pickup", lat: 1, lng: 2},
    items: [{itemId: "item-1", name: "Meal", quantity: 2, price: 100, variant: "", variantPrice: 0, addOns: [], addOnTotal: 0, note: "private", diet: "veg"}],
    pricing: {subtotal: 200, discount: 0, deliveryFee: 20, smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0, platformFee: 5, tax: 0, tip: 0, currency: "INR", source: "catalog_snapshot_v3"},
    pricingContext: {distanceKm: 1, platformFeeRule: "v1", weatherSeverity: "none", surgeActiveOrders: 0, pricedAt: 1_000},
    total: 225,
    coupon: "",
    paymentMethod: "cod",
    paymentState: "cash_due",
    deliveryMode: "asap",
    address: {id: "address-1", label: "Home", area: "Private", address: "Private", phone: "9999999999", source: "manual", lat: 1, lng: 2, updatedAt: 1_000},
    instructions: "private",
    contactless: false,
    status: "Accepted",
    statusHistory: {},
    createdAt: 1_000,
    updatedAt: 2_000,
    etaMin: 20,
    etaMax: 30,
    ...overrides,
  };
}

describe("operational order projection", () => {
  it("contains an active sort key and excludes private delivery/order detail", () => {
    const projection = buildOperationalOrderProjection(order());
    expect(projection).toMatchObject({
      orderId: "order-1",
      active: true,
      itemCount: 2,
      activeSortKey: "active:0000000002000:order-1",
    });
    expect(projection).not.toHaveProperty("address");
    expect(projection).not.toHaveProperty("customerPhone");
    expect(projection).not.toHaveProperty("items");
    expect(projection).not.toHaveProperty("instructions");
  });

  it("moves terminal orders into the recent lane", () => {
    const projection = buildOperationalOrderProjection(order({status: "Delivered", updatedAt: 3_000}));
    expect(projection).toMatchObject({
      active: false,
      terminalAt: 3_000,
      recentSortKey: "recent:0000000003000:order-1",
    });
    expect(projection.activeSortKey).toBeUndefined();
  });

  it("rejects stale and backwards trigger retries", () => {
    const accepted = buildOperationalOrderProjection(order({status: "Accepted", updatedAt: 2_000}));
    const preparing = buildOperationalOrderProjection(order({status: "Preparing", updatedAt: 3_000}));
    expect(shouldApplyOperationalOrderProjection(accepted, preparing)).toBe(true);
    expect(shouldApplyOperationalOrderProjection(preparing, accepted)).toBe(false);
    const backwardsAtSameTime = buildOperationalOrderProjection(order({status: "Accepted", updatedAt: 3_000}));
    expect(shouldApplyOperationalOrderProjection(preparing, backwardsAtSameTime)).toBe(false);
  });
});
