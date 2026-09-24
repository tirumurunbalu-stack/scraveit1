import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SavrivoOrder} from "../src/types";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}));

function clone<T>(value: T): T {
  return structuredClone(value);
}

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {
    db: {
      ref: (path: string) => ({
        get: async () => ({val: () => clone(memory.values.get(path) ?? null)}),
      }),
    },
    firestoreDb: new InMemoryFirestore(),
  };
});

import {ROOT} from "../src/config";
import {firestoreDb} from "../src/admin";
import {
  markRiderArrivedRestaurant,
} from "../src/services/riderRestaurantArrival";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const database = firestoreDb as unknown as InMemoryFirestore;

const now = 1_800_000_000_000;
const riderId = "rider-1";
const customerId = "customer-1";
const restaurantId = "restaurant-1";
const orderId = "SV-ARRIVAL-1";

function arrivalPath(id: string): string {
  return `riderRestaurantArrivals/${id}`;
}

function riderJobPath(rider: string, order: string): string {
  return `riderJobs/${rider}_${order}`;
}

function operationalOrderPath(id: string): string {
  return `private/operations/operationalOrders/${id}`;
}

function order(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: orderId,
    customerId,
    restaurantId,
    status: "Preparing",
    riderId,
    restaurantLocation: {address: "Pickup", lat: 13.9000, lng: 79.8800},
    ...overrides,
  } as SavrivoOrder;
}

function tracking(overrides: Record<string, unknown> = {}) {
  return {
    orderId,
    customerId,
    riderId,
    lat: 13.9002,
    lng: 79.8800,
    accuracy: 12,
    updatedAt: now - 1_000,
    phase: "pickup",
    status: "live",
    ...overrides,
  };
}

async function seed(overrides: {order?: Partial<SavrivoOrder>; tracking?: Record<string, unknown>} = {}) {
  await database.seed(riderJobPath(riderId, orderId), {customerId, status: "active"});
  await database.seed(`orders/${orderId}`, order(overrides.order));
  await database.seed(`riders/${riderId}`, {status: "approved"});
  memory.values.set(`${ROOT}/tracking/${orderId}`, tracking(overrides.tracking));
  memory.values.set(`${ROOT}/riderPresence/${riderId}`, {
    online: true,
    riderId,
    riderName: "Rider One",
    updatedAt: now - 1_000,
    city: "Naidupet",
    lat: 13.9002,
    lng: 79.8800,
    accuracy: 12,
    activeOrderId: orderId,
  });
}

describe("authoritative rider restaurant arrival", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    for (const path of database.paths()) await database.doc(path).delete();
    memory.values.clear();
    await seed();
  });

  it("atomically records bounded evidence and reconciles Rider and Admin projections", async () => {
    const result = await markRiderArrivedRestaurant(riderId, orderId, now);
    expect(result).toMatchObject({orderId, riderId, arrivedAt: now, idempotent: false});
    expect(result.distanceMeters).toBeGreaterThan(0);

    const record = database.read(arrivalPath(orderId));
    expect(record).toMatchObject({
      status: "verified",
      source: "server_verified_pickup_tracking",
      orderId,
      riderId,
      restaurantId,
      arrivedAt: now,
    });
    expect(record).not.toHaveProperty("lat");
    expect(record).not.toHaveProperty("lng");
    expect(database.read(riderJobPath(riderId, orderId))).toMatchObject({phase: "at_restaurant"});
    expect(database.read(operationalOrderPath(orderId))).toMatchObject({
      riderArrivalVerified: true,
      riderArrivedRestaurantAt: now,
    });
  });

  it("makes a completed verification retry idempotent without changing its timestamp", async () => {
    const first = await markRiderArrivedRestaurant(riderId, orderId, now);
    const retry = await markRiderArrivedRestaurant(riderId, orderId, now + 10_000);
    expect(first.idempotent).toBe(false);
    expect(retry).toMatchObject({idempotent: true, arrivedAt: now});
    expect(database.read(arrivalPath(orderId))).toMatchObject({arrivedAt: now});
  });

  it("waits for an in-progress verification to finish and returns the verified result", async () => {
    vi.useFakeTimers();
    await database.seed(arrivalPath(orderId), {
      version: 1,
      source: "server_verified_pickup_tracking",
      status: "verifying",
      orderId,
      riderId,
      operationId: "arrival_pending",
      leaseUntil: now + 30_000,
      updatedAt: now,
    });

    const verifiedRecord = {
      version: 1,
      source: "server_verified_pickup_tracking",
      status: "verified",
      orderId,
      restaurantId,
      riderId,
      arrivedAt: now,
      verifiedAt: now,
      trackingUpdatedAt: now - 1_000,
      distanceMeters: 21,
      accuracyMeters: 12,
    };

    const promise = markRiderArrivedRestaurant(riderId, orderId, now);
    setTimeout(() => {
      void database.seed(arrivalPath(orderId), clone(verifiedRecord));
    }, 600);

    await vi.advanceTimersByTimeAsync(1_000);
    const retry = await promise;

    expect(retry).toMatchObject({idempotent: true, arrivedAt: now, orderId, riderId});
    expect(database.read(arrivalPath(orderId))).toMatchObject(verifiedRecord);
  });

  it("rejects stale, inaccurate, far, delivery-phase, and mismatched tracking", async () => {
    const cases = [
      {updatedAt: now - 30_001},
      {accuracy: 80.1},
      {lat: 13.9100},
      {phase: "delivery"},
      {riderId: "rider-2"},
    ];
    for (const invalid of cases) {
      await database.doc(arrivalPath(orderId)).delete();
      memory.values.set(`${ROOT}/tracking/${orderId}`, tracking(invalid));
      memory.values.set(`${ROOT}/riderPresence/${riderId}`, {
        online: true,
        riderId,
        riderName: "Rider One",
        updatedAt: now - 120_000,
        city: "Naidupet",
        lat: 13.9500,
        lng: 79.9500,
        accuracy: 12,
        activeOrderId: orderId,
      });
      await expect(markRiderArrivedRestaurant(riderId, orderId, now)).rejects.toThrow(
        "Restaurant arrival could not be verified.",
      );
      expect(database.read(arrivalPath(orderId))).toBeNull();
    }
  });

  it("falls back to fresh rider presence when pickup tracking is temporarily unavailable", async () => {
    memory.values.set(`${ROOT}/tracking/${orderId}`, {
      orderId,
      customerId,
      riderId,
      lat: 13.9002,
      lng: 79.8800,
      accuracy: 12,
      updatedAt: now - 45_000,
      phase: "pickup",
      status: "live",
    });

    const result = await markRiderArrivedRestaurant(riderId, orderId, now);

    expect(result).toMatchObject({orderId, riderId, arrivedAt: now, idempotent: false});
    expect(database.read(arrivalPath(orderId))).toMatchObject({
      status: "verified",
      source: "server_verified_pickup_presence",
      orderId,
      riderId,
      restaurantId,
      arrivedAt: now,
    });
  });

  it("rejects another rider and unsupported lifecycle states before writing evidence", async () => {
    await expect(markRiderArrivedRestaurant("rider-2", orderId, now)).rejects.toThrow(
      "Assigned delivery was not found.",
    );
    await database.seed(`orders/${orderId}`, order({status: "Out for delivery"}));
    await expect(markRiderArrivedRestaurant(riderId, orderId, now)).rejects.toThrow(
      "Restaurant arrival could not be verified.",
    );
    expect(database.read(arrivalPath(orderId))).toBeNull();
  });
});
