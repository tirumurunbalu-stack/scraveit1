import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SavrivoOrder} from "../src/types";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  transactions: [] as string[],
  query: [] as Array<[string, unknown]>,
}));

vi.mock("firebase-functions", () => ({logger: {info: vi.fn()}}));
vi.mock("../src/admin", () => ({
  db: {
    ref: (path: string) => {
      const chain = {
        transaction: async (update: (current: unknown) => unknown) => {
          memory.transactions.push(path);
          const next = update(memory.values.get(path) ?? null);
          if (next !== undefined) memory.values.set(path, next);
          return {committed: next !== undefined, snapshot: {val: () => memory.values.get(path) ?? null}};
        },
        orderByChild: (child: string) => {
          memory.query.push(["orderByChild", child]);
          return chain;
        },
        startAt: (value: unknown) => {
          memory.query.push(["startAt", value]);
          return chain;
        },
        endAt: (value: unknown) => {
          memory.query.push(["endAt", value]);
          return chain;
        },
        limitToLast: (value: unknown) => {
          memory.query.push(["limitToLast", value]);
          return chain;
        },
        get: async () => ({val: () => memory.values.get(path) ?? null}),
      };
      return chain;
    },
  },
}));

import {
  listActiveOperationalOrders,
  OPERATIONAL_ORDERS_ROOT,
  parseOperationalOrderProjection,
  reconcileOperationalOrderProjection,
} from "../src/services/operationalOrders";

function order(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: "order-1", schemaVersion: 3, idempotencyKey: "key-1", customerId: "customer-1",
    customerName: "Private", customerPhone: "999", restaurantId: "restaurant-1", restaurant: "Restaurant",
    restaurantLocation: {address: "Private", lat: 1, lng: 2},
    items: [{itemId: "item", name: "Meal", quantity: 1, price: 100, variant: "", variantPrice: 0, addOns: [], addOnTotal: 0, note: "", diet: "veg"}],
    pricing: {subtotal: 100, discount: 0, deliveryFee: 20, smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0, platformFee: 5, tax: 0, tip: 0, currency: "INR", source: "catalog_snapshot_v3"},
    pricingContext: {distanceKm: 1, platformFeeRule: "v1", weatherSeverity: "none", surgeActiveOrders: 0, pricedAt: 1_000},
    total: 125, coupon: "", paymentMethod: "cod", paymentState: "cash_due", deliveryMode: "asap",
    address: {id: "address", label: "Home", area: "Private", address: "Private", phone: "999", source: "manual", lat: 1, lng: 2, updatedAt: 1_000},
    instructions: "", contactless: false, status: "Accepted", statusHistory: {}, createdAt: 1_000,
    updatedAt: 2_000, etaMin: 20, etaMax: 30,
    ...overrides,
  };
}

describe("operational order projection service", () => {
  beforeEach(() => {
    memory.values.clear();
    memory.transactions.length = 0;
    memory.query.length = 0;
  });

  it("reconciles only the privacy-minimized per-order head", async () => {
    const result = await reconcileOperationalOrderProjection(order());
    expect(memory.transactions).toEqual([`${OPERATIONAL_ORDERS_ROOT}/order-1`]);
    expect(result).toMatchObject({orderId: "order-1", active: true, itemCount: 1});
    expect(result).not.toHaveProperty("address");
    expect(result).not.toHaveProperty("items");
  });

  it("enforces a bounded active-order query", async () => {
    const source = order({id: "one", updatedAt: 5});
    await reconcileOperationalOrderProjection(source);
    memory.values.set(OPERATIONAL_ORDERS_ROOT, {
      one: memory.values.get(`${OPERATIONAL_ORDERS_ROOT}/one`),
    });
    memory.transactions.length = 0;
    memory.query.length = 0;
    const result = await listActiveOperationalOrders(10_000);
    expect(memory.query).toEqual([
      ["orderByChild", "activeSortKey"],
      ["startAt", "active:"],
      ["endAt", "active:\uf8ff"],
      ["limitToLast", 250],
    ]);
    expect(result).toHaveLength(1);
  });

  it("retains only bounded rider-arrival proof fields for Admin handover", () => {
    const base = {
      ...reconcileShape(order({status: "Assigned", riderId: "rider-1"})),
      riderArrivalVerified: true,
      riderArrivedRestaurantAt: 2_500,
      lat: 13.9,
      lng: 79.9,
    };
    const parsed = parseOperationalOrderProjection(base, "order-1");
    expect(parsed).toMatchObject({
      orderId: "order-1",
      riderId: "rider-1",
      riderArrivalVerified: true,
      riderArrivedRestaurantAt: 2_500,
    });
    expect(parsed).not.toHaveProperty("lat");
    expect(parsed).not.toHaveProperty("lng");
    expect(parseOperationalOrderProjection({...base, riderArrivedRestaurantAt: undefined}, "order-1")).toBeNull();
  });
});

function reconcileShape(source: SavrivoOrder) {
  const active = source.status !== "Delivered" && source.status !== "Cancelled";
  return {
    version: 1,
    source: "functions",
    orderId: source.id,
    customerId: source.customerId,
    restaurantId: source.restaurantId,
    restaurantName: source.restaurant,
    riderId: source.riderId,
    status: source.status,
    active,
    ...(active ? {activeSortKey: `active:${String(source.updatedAt).padStart(13, "0")}:${source.id}`} : {}),
    paymentMethod: source.paymentMethod,
    paymentState: source.paymentState,
    total: source.total,
    currency: "INR",
    itemCount: source.items.reduce((sum, item) => sum + item.quantity, 0),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}
