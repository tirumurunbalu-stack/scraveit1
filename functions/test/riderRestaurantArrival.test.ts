import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SavrivoOrder} from "../src/types";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  rootUpdates: [] as Array<Record<string, unknown>>,
}));

function clone<T>(value: T): T {
  return structuredClone(value);
}

vi.mock("../src/admin", () => ({
  db: {
    ref: (path: string) => ({
      get: async () => ({val: () => clone(memory.values.get(path) ?? null)}),
      update: async (patch: Record<string, unknown>) => {
        if (path === "feastly") {
          memory.rootUpdates.push(clone(patch));
          for (const [relativePath, value] of Object.entries(patch)) {
            const absolutePath = `${path}/${relativePath}`;
            if (value === null) memory.values.delete(absolutePath);
            else memory.values.set(absolutePath, clone(value));
          }
          return;
        }
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
        if (next === null) memory.values.delete(path);
        else memory.values.set(path, clone(next));
        return {committed: true, snapshot: {val: () => clone(next)}};
      },
    }),
  },
}));

import {pathFor, ROOT} from "../src/config";
import {
  markRiderArrivedRestaurant,
  RIDER_RESTAURANT_ARRIVALS_ROOT,
} from "../src/services/riderRestaurantArrival";

const now = 1_800_000_000_000;
const riderId = "rider-1";
const customerId = "customer-1";
const restaurantId = "restaurant-1";
const orderId = "SV-ARRIVAL-1";

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

function seed(overrides: {order?: Partial<SavrivoOrder>; tracking?: Record<string, unknown>} = {}) {
  memory.values.set(`${ROOT}/riderJobs/${riderId}/${orderId}`, {customerId, status: "active"});
  memory.values.set(pathFor.order(customerId, orderId), order(overrides.order));
  memory.values.set(`${ROOT}/riders/${riderId}`, {status: "approved"});
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
  beforeEach(() => {
    vi.useRealTimers();
    memory.values.clear();
    memory.rootUpdates.length = 0;
    seed();
  });

  it("atomically records bounded evidence and reconciles Rider, Restaurant and Admin projections", async () => {
    const result = await markRiderArrivedRestaurant(riderId, orderId, now);
    expect(result).toMatchObject({orderId, riderId, arrivedAt: now, idempotent: false});
    expect(result.distanceMeters).toBeGreaterThan(0);

    const record = memory.values.get(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`);
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
    expect(memory.values.get(`${ROOT}/riderJobs/${riderId}/${orderId}/phase`)).toBe("at_restaurant");
    expect(memory.values.get(
      `${ROOT}/restaurantOrders/${restaurantId}/${customerId}/${orderId}/riderArrivedRestaurantAt`,
    )).toBe(now);
    expect(memory.values.get(
      `${ROOT}/restaurantOrders/${restaurantId}/${customerId}/${orderId}/riderArrivalVerified`,
    )).toBe(true);
    expect(memory.values.get(`${ROOT}/private/operations/orders/${orderId}/riderArrivalVerified`)).toBe(true);
    expect(memory.rootUpdates).toHaveLength(1);
  });

  it("makes a completed verification retry idempotent without changing its timestamp", async () => {
    const first = await markRiderArrivedRestaurant(riderId, orderId, now);
    const retry = await markRiderArrivedRestaurant(riderId, orderId, now + 10_000);
    expect(first.idempotent).toBe(false);
    expect(retry).toMatchObject({idempotent: true, arrivedAt: now});
    expect(memory.values.get(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`)).toMatchObject({arrivedAt: now});
  });

  it("waits for an in-progress verification to finish and returns the verified result", async () => {
    vi.useFakeTimers();
    memory.values.set(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`, {
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
      memory.values.set(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`, clone(verifiedRecord));
    }, 600);

    await vi.advanceTimersByTimeAsync(1_000);
    const retry = await promise;

    expect(retry).toMatchObject({idempotent: true, arrivedAt: now, orderId, riderId});
    expect(memory.values.get(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`)).toMatchObject(verifiedRecord);
  });

  it("rejects stale, inaccurate, far, delivery-phase, and mismatched tracking", async () => {
    const cases = [
      {updatedAt: now - 30_001},
      {accuracy: 50.1},
      {lat: 13.9100},
      {phase: "delivery"},
      {riderId: "rider-2"},
    ];
    for (const invalid of cases) {
      memory.values.delete(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`);
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
      expect(memory.values.has(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`)).toBe(false);
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
    expect(memory.values.get(`${RIDER_RESTAURANT_ARRIVALS_ROOT}/${orderId}`)).toMatchObject({
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
    memory.values.set(pathFor.order(customerId, orderId), order({status: "Out for delivery"}));
    await expect(markRiderArrivedRestaurant(riderId, orderId, now)).rejects.toThrow(
      "Restaurant arrival could not be verified.",
    );
    expect(memory.rootUpdates).toHaveLength(0);
  });
});
