import {beforeEach, describe, expect, it, vi} from "vitest";

const memory = vi.hoisted(() => ({rtdbFails: false}));

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {
    db: {
      ref: () => ({
        get: async () => {
          if (memory.rtdbFails) throw new Error("RTDB_DOWN");
          return {val: () => null};
        },
        limitToFirst: () => ({
          get: async () => {
            if (memory.rtdbFails) throw new Error("RTDB_DOWN");
            return {val: () => null};
          },
        }),
      }),
    },
    firestoreDb: new InMemoryFirestore(),
  };
});

import {firestoreDb} from "../src/admin";
import {availabilityCityKey} from "../src/domain/dispatch";
import {deriveRiderDispatchEligibility} from "../src/domain/riderEligibility";
import {deliveryPartnerCheckSchema} from "../src/schemas";
import {assertDeliveryPartnerFreeNear, deliveryPartnerStatusForRestaurant} from "../src/services/dispatch";
import {clearPlatformConfigCache} from "../src/services/platformConfig";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const database = firestoreDb as unknown as InMemoryFirestore;
// Highway Cross, Nellore.
const store = {id: "r1", name: "Highway Cross", city: "Nellore", lat: 14.4426, lng: 79.9865};
const BUSY = "All delivery partners near Highway Cross are busy right now. Please try again in a few minutes.";

function partner(id: string, kmNorth: number, options: {onDelivery?: boolean; approved?: boolean} = {}): void {
  const now = Date.now();
  database.seed(`riderAvailability/${id}`, {
    riderId: id, riderName: id, city: "Nellore", cityKey: availabilityCityKey("Nellore"), online: true,
    lat: store.lat + kmNorth / 111.2, lng: store.lng, accuracy: 10, updatedAt: now,
    ...(options.onDelivery ? {activeOrderId: "SV-OTHER"} : {}),
  });
  database.seed(`private/riderDispatchEligibility/riders/${id}`, deriveRiderDispatchEligibility(
    id,
    {status: options.approved === false ? "pending" : "approved", fullName: id},
    {},
    options.onDelivery ? {"SV-OTHER": {orderStatus: "Out for delivery", phase: "drop"} as never} : {},
    now,
  ));
}

beforeEach(async () => {
  for (const path of database.paths()) await database.recursiveDelete(database.doc(path));
  memory.rtdbFails = false;
  clearPlatformConfigCache();
  database.seed("restaurants/r1", store);
  database.seed("platformConfig/config", {dispatch: {mode: "sequential", initialRadiusKm: 5, radiusExpansionKm: 0, maxRadiusKm: 5}});
});

describe("delivery partner check before an order is placed", () => {
  it("blocks the order with the busy message when no delivery partner is online", async () => {
    await expect(assertDeliveryPartnerFreeNear(store)).rejects.toThrow(BUSY);
  });

  it("allows the order when a free delivery partner is within 5 km", async () => {
    partner("near", 1);
    await expect(assertDeliveryPartnerFreeNear(store)).resolves.toBeUndefined();
  });

  it("blocks when the only free delivery partner is 6 km away", async () => {
    partner("far", 6);
    await expect(assertDeliveryPartnerFreeNear(store)).rejects.toThrow(BUSY);
  });

  it("blocks when the nearby delivery partners are all on deliveries or not approved", async () => {
    partner("busy", 1, {onDelivery: true});
    partner("pending", 1, {approved: false});
    await expect(assertDeliveryPartnerFreeNear(store)).rejects.toThrow(BUSY);
  });

  it("allows when one of several nearby delivery partners is free", async () => {
    partner("busy", 0.5, {onDelivery: true});
    partner("free", 4.5);
    await expect(assertDeliveryPartnerFreeNear(store)).resolves.toBeUndefined();
  });

  it("skips the check for a store that delivers its own orders", async () => {
    await expect(assertDeliveryPartnerFreeNear({...store, selfDelivery: true})).resolves.toBeUndefined();
  });

  it("never blocks an order because our own read failed", async () => {
    memory.rtdbFails = true;
    await expect(assertDeliveryPartnerFreeNear(store)).resolves.toBeUndefined();
  });
});

describe("delivery partner status shown when the restaurant page opens", () => {
  it("says busy, with the same message as Place order, when no delivery partner is free", async () => {
    await expect(deliveryPartnerStatusForRestaurant("r1")).resolves.toEqual({busy: true, message: BUSY});
  });

  it("says not busy when a free delivery partner is within 5 km", async () => {
    partner("near", 2);
    await expect(deliveryPartnerStatusForRestaurant("r1")).resolves.toEqual({busy: false, message: ""});
  });

  it("says busy when the nearby delivery partners are all on deliveries", async () => {
    partner("busy", 1, {onDelivery: true});
    await expect(deliveryPartnerStatusForRestaurant("r1")).resolves.toEqual({busy: true, message: BUSY});
  });

  it("never says busy for a store with no map pin, a store that delivers itself, or an unknown store", async () => {
    database.seed("restaurants/nopin", {id: "nopin", name: "No Pin", city: "Nellore"});
    database.seed("restaurants/self", {...store, id: "self", selfDelivery: true});
    await expect(deliveryPartnerStatusForRestaurant("nopin")).resolves.toEqual({busy: false, message: ""});
    await expect(deliveryPartnerStatusForRestaurant("self")).resolves.toEqual({busy: false, message: ""});
    await expect(deliveryPartnerStatusForRestaurant("missing")).resolves.toEqual({busy: false, message: ""});
  });

  it("never says busy because our own read failed", async () => {
    memory.rtdbFails = true;
    await expect(deliveryPartnerStatusForRestaurant("r1")).resolves.toEqual({busy: false, message: ""});
  });

  it("accepts only the small check request, so a pricing request is never mistaken for it", () => {
    expect(deliveryPartnerCheckSchema.safeParse({restaurantId: "r1", deliveryPartnerCheck: true}).success).toBe(true);
    expect(deliveryPartnerCheckSchema.safeParse({restaurantId: "r1", deliveryPartnerCheck: false}).success).toBe(false);
    expect(deliveryPartnerCheckSchema.safeParse({restaurantId: "r1", deliveryPartnerCheck: true, items: []}).success).toBe(false);
    expect(deliveryPartnerCheckSchema.safeParse({deliveryPartnerCheck: true}).success).toBe(false);
  });
});
