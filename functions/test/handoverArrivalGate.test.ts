import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SavrivoOrder} from "../src/types";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore(), db: {}};
});

vi.mock("../src/services/authz", () => ({
  authorizeTransition: vi.fn(async () => "staff"),
}));

vi.mock("../src/services/orderProjection", () => ({
  reconcileRestaurantOrderProjection: vi.fn(async () => undefined),
}));

vi.mock("../src/services/workload", () => ({
  reconcileRestaurantWorkload: vi.fn(async () => undefined),
}));

import {firestoreDb} from "../src/admin";
import {transitionOrder} from "../src/services/orders";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const database = firestoreDb as unknown as InMemoryFirestore;

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

function orderPath(id: string): string {
  return `orders/${id}`;
}

function arrivalPath(id: string): string {
  return `riderRestaurantArrivals/${id}`;
}

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
  beforeEach(async () => {
    for (const path of database.paths()) await database.doc(path).delete();
    database.seed(orderPath(orderId), assignedOrder());
  });

  it("rejects handover without durable server-verified arrival evidence", async () => {
    await expect(transitionOrder("staff-1", token, request)).rejects.toThrow(
      "Confirm the assigned rider's verified restaurant arrival before handover.",
    );
    expect(database.paths().filter((path) => path.startsWith("audit/"))).toHaveLength(0);
  });

  it.each([
    {riderId: "rider-2"},
    {restaurantId: "restaurant-2"},
    {orderId: "another-order"},
    {status: "verifying"},
  ])("rejects mismatched or unfinished evidence: %o", async (override) => {
    database.seed(arrivalPath(orderId), verifiedArrival(override));
    await expect(transitionOrder("staff-1", token, request)).rejects.toThrow(
      "Confirm the assigned rider's verified restaurant arrival before handover.",
    );
    expect(database.paths().filter((path) => path.startsWith("audit/"))).toHaveLength(0);
  });

  it("allows exactly the current assignment to move Assigned to Handed to rider", async () => {
    database.seed(arrivalPath(orderId), verifiedArrival());
    const result = await transitionOrder("staff-1", token, request);
    expect(result).toMatchObject({idempotent: false, order: {status: "Handed to rider", riderId}});
    expect(database.paths().filter((path) => path.startsWith("audit/"))).toHaveLength(1);
    expect(database.read(orderPath(orderId))).toMatchObject({status: "Handed to rider"});
  });

  it("keeps a lost-response handover retry idempotent without requiring a second proof write", async () => {
    database.seed(arrivalPath(orderId), verifiedArrival());
    await transitionOrder("staff-1", token, request);
    await database.doc(arrivalPath(orderId)).delete();
    const retry = await transitionOrder("staff-1", token, request);
    expect(retry).toMatchObject({idempotent: true, order: {status: "Handed to rider", riderId}});
    expect(database.paths().filter((path) => path.startsWith("audit/"))).toHaveLength(1);
  });
});
