import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SavrivoOrder} from "../src/types";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  transactionAttempts: 0,
  transactionCommits: 0,
  projectionReconciles: 0,
  workloadReconciles: 0,
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
        memory.values.set(path, {...(current && typeof current === "object" ? clone(current) : {}), ...clone(patch)});
      },
      transaction: async (update: (current: unknown) => unknown) => {
        memory.transactionAttempts += 1;
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
  reconcileRestaurantOrderProjection: vi.fn(async () => { memory.projectionReconciles += 1; }),
}));

vi.mock("../src/services/workload", () => ({
  reconcileRestaurantWorkload: vi.fn(async () => { memory.workloadReconciles += 1; }),
}));

import {pathFor, ROOT} from "../src/config";
import {transitionOrder} from "../src/services/orders";

function readyOrder(): SavrivoOrder {
  return {
    id: "SV-READY-RECOVERY-1",
    schemaVersion: 3,
    idempotencyKey: "ready-recovery-1",
    customerId: "customer-1",
    customerName: "Customer",
    customerPhone: "9000000000",
    restaurantId: "restaurant-1",
    restaurant: "Restaurant",
    restaurantLocation: {address: "Restaurant address", lat: 13.9, lng: 79.9},
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
    status: "Ready for pickup",
    statusHistory: {
      ready: {status: "Ready for pickup", at: 2_000, actorId: "staff-1", actorRole: "staff"},
    },
    riderId: "rider-1",
    riderName: "Rider",
    riderAssignedAt: 1_900,
    createdAt: 1_000,
    updatedAt: 2_000,
    etaMin: 20,
    etaMax: 30,
  };
}

const token = {uid: "staff-1", email: "staff@example.com"} as unknown as DecodedIdToken;
const retry = {
  customerId: "customer-1",
  orderId: "SV-READY-RECOVERY-1",
  toStatus: "Ready for pickup" as const,
  reason: "",
  cashCollected: false,
};

describe("Ready-for-pickup assignment recovery", () => {
  beforeEach(() => {
    memory.values.clear();
    memory.transactionAttempts = 0;
    memory.transactionCommits = 0;
    memory.projectionReconciles = 0;
    memory.workloadReconciles = 0;
    memory.values.set(pathFor.order("customer-1", "SV-READY-RECOVERY-1"), readyOrder());
  });

  it("promotes an interrupted idempotent Ready retry to Assigned exactly once", async () => {
    const first = await transitionOrder("staff-1", token, retry);
    expect(first).toMatchObject({actorRole: "staff", idempotent: true, order: {status: "Assigned", riderId: "rider-1"}});
    expect(Object.values(first.order.statusHistory).filter((event) => event.status === "Assigned")).toHaveLength(1);
    expect(memory.transactionCommits).toBe(1);
    expect(memory.projectionReconciles).toBe(1);
    expect(memory.workloadReconciles).toBe(1);
    expect([...memory.values.keys()].filter((path) => path.startsWith(`${ROOT}/audit/`))).toHaveLength(1);

    const second = await transitionOrder("staff-1", token, retry);
    expect(second).toMatchObject({idempotent: true, order: {status: "Assigned", riderId: "rider-1"}});
    expect(memory.transactionCommits).toBe(1);
    expect(Object.values(second.order.statusHistory).filter((event) => event.status === "Assigned")).toHaveLength(1);
  });

  it("lets concurrent recovery retries converge on one system transition and one effect set", async () => {
    const [one, two] = await Promise.all([
      transitionOrder("staff-1", token, retry),
      transitionOrder("staff-1", token, retry),
    ]);
    expect([one.order.status, two.order.status]).toEqual(["Assigned", "Assigned"]);
    expect(memory.transactionCommits).toBe(1);
    expect(memory.projectionReconciles).toBe(1);
    expect(memory.workloadReconciles).toBe(1);
    expect([...memory.values.keys()].filter((path) => path.startsWith(`${ROOT}/audit/`))).toHaveLength(1);
    const canonical = memory.values.get(pathFor.order("customer-1", "SV-READY-RECOVERY-1")) as SavrivoOrder;
    expect(Object.values(canonical.statusHistory).filter((event) => event.status === "Assigned")).toHaveLength(1);
  });
});
