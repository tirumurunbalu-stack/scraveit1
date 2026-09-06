import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SavrivoOrder} from "../src/types";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  transactionCommits: 0,
}));

function clone<T>(value: T): T {
  return structuredClone(value);
}

vi.mock("../src/admin", () => ({
  db: {
    ref: (path: string) => ({
      get: async () => ({val: () => clone(memory.values.get(path) ?? null)}),
      set: async (value: unknown) => { memory.values.set(path, clone(value)); },
      update: async (patch: Record<string, unknown>) => {
        const current = memory.values.get(path);
        memory.values.set(path, {
          ...(current && typeof current === "object" ? clone(current) : {}),
          ...clone(patch),
        });
      },
      transaction: async (update: (current: unknown) => unknown) => {
        const current = clone(memory.values.get(path) ?? null);
        const next = update(current);
        if (next === undefined) {
          return {committed: false, snapshot: {val: () => clone(memory.values.get(path) ?? null)}};
        }
        memory.transactionCommits += 1;
        memory.values.set(path, clone(next));
        return {committed: true, snapshot: {val: () => clone(next)}};
      },
    }),
  },
}));

vi.mock("../src/services/authz", () => ({
  authorizeTransition: vi.fn(async () => "staff"),
}));

vi.mock("../src/services/orderProjection", () => ({
  reconcileRestaurantOrderProjection: vi.fn(async () => undefined),
}));

vi.mock("../src/services/workload", () => ({
  reconcileRestaurantWorkload: vi.fn(async () => undefined),
}));

import {pathFor, ROOT} from "../src/config";
import {transitionOrder} from "../src/services/orders";
import {RIDER_RESTAURANT_ARRIVALS_ROOT} from "../src/services/riderRestaurantArrival";

const customerId = "customer-1";
const orderId = "SV-HANDOVER-GATE-1";
const restaurantId = "restaurant-1";
const riderId = "rider-1";
const token = {uid: "staff-1", email: "staff@example.com"} as unknown as DecodedIdToken;
const request = {
  customerId,
  orderId,
  toStatus: "Handed to rider" as const,
  reason: "",
  cashCollected: false,
};

function assignedOrder(): SavrivoOrder {
  return {
    id: orderId,
    schemaVersion: 3,
    idempotencyKey: "handover-gate-1",
    customerId,
    customerName: "Customer",
    customerPhone: "9000000000",
    restaurantId,
    restaurant: "Restaurant",
    restaurantLocation: {address: "Pickup", lat: 13.9, lng: 79.9},
    items: [],
    pricing: {
      subtotal: 100, discount: 0, deliveryFee: 20, smallOrderFee: 0, lateNightFee: 0,
      rainFee: 0, surgeFee: 0, platformFee: 5, tax: 5, tip: 0, currency: "INR",
      source: "catalog_snapshot_v3",
    },
    pricingContext: {
      distanceKm: 1, platformFeeRule: "test", weatherSeverity: "none",
      surgeActiveOrders: 0, pricedAt: 1_000,
    },
    total: 130,
    coupon: "",
    paymentMethod: "cod",
    paymentState: "cash_due",
    deliveryMode: "asap",
    address: {
      id: "address-1", label: "Home", area: "Area", address: "Customer address",
      phone: "9000000000", source: "manual", lat: 13.91, lng: 79.91, updatedAt: 1_000,
    },
    instructions: "",
    contactless: false,
    status: "Assigned",
    statusHistory: {
      assigned: {status: "Assigned", at: 2_000, actorId: "dispatch", actorRole: "system"},
    },
    riderId,
    riderName: "Rider",
    riderAssignedAt: 1_900,
    createdAt: 1_000,
    updatedAt: 2_000,
    etaMin: 20,
    etaMax: 30,
  };
}

function verifiedArrival(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    source: "server_verified_pickup_tracking",
    status: "verified",
    orderId,
    restaurantId,
    riderId,
    arrivedAt: 2_500,
    verifiedAt: 2_500,
    trackingUpdatedAt: 2_499,
    distanceMeters: 25,
    accuracyMeters: 10,
    ...overrides,
  };
}

describe("server-authoritative restaurant handover arrival gate", () => {
  beforeEach(() => {
    memory.values.clear();
    memory.transactionCommits = 0;
    memory.values.set(pathFor.order(customerId, orderId), assignedOrder());
  });

  it("rejects handover without durable server-verified arrival evidence", async () => {
    await expect(transitionOrder("staff-1", token, request)).rejects.toThrow(
      "Confirm the assigned rider's verified restaurant arrival before handover.",
    );
    expect(memory.transactionCommits).toBe(0);
  });

  it.each([
    {riderId: "rider-2"},
    {restaurantId: "restaurant-2"},
    {orderId: "another-order"},
    {status: "verifying"},
  ])("rejects mismatched or unfinished evidence: %o", async (override) => {
    memory.values.set(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`, verifiedArrival(override));
    await expect(transitionOrder("staff-1", token, request)).rejects.toThrow(
      "Confirm the assigned rider's verified restaurant arrival before handover.",
    );
    expect(memory.transactionCommits).toBe(0);
  });

  it("allows exactly the current assignment to move Assigned to Handed to rider", async () => {
    memory.values.set(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`, verifiedArrival());
    const result = await transitionOrder("staff-1", token, request);
    expect(result).toMatchObject({idempotent: false, order: {status: "Handed to rider", riderId}});
    expect(memory.transactionCommits).toBe(1);
    expect(memory.values.get(pathFor.order(customerId, orderId))).toMatchObject({status: "Handed to rider"});
  });

  it("keeps a lost-response handover retry idempotent without requiring a second proof write", async () => {
    memory.values.set(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`, verifiedArrival());
    await transitionOrder("staff-1", token, request);
    memory.values.delete(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`);
    const retry = await transitionOrder("staff-1", token, request);
    expect(retry).toMatchObject({idempotent: true, order: {status: "Handed to rider", riderId}});
    expect(memory.transactionCommits).toBe(1);
  });
});

