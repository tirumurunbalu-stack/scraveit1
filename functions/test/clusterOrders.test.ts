import {beforeEach, describe, expect, it, vi} from "vitest";

// Cluster orders, end to end through the real order code: one checkout across restaurants in one
// area becomes one order per restaurant, priced as a whole (one delivery fee, a stop fee for each
// extra restaurant), sharing one delivery code, collected by one rider in a care-first order.

const {packNotices, rtdb} = vi.hoisted(() => ({packNotices: [] as Array<Record<string, string>>, rtdb: new Map<string, unknown>()}));

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  const ref = (path: string) => ({
    get: async () => ({val: () => rtdb.get(path) ?? null, exists: () => rtdb.has(path)}),
    set: async (value: unknown) => { rtdb.set(path, value); },
    remove: async () => { rtdb.delete(path); },
    limitToFirst: () => ({get: async () => ({val: () => null})}),
  });
  return {
    firestoreDb: new InMemoryFirestore(),
    db: {ref},
    messaging: {sendEachForMulticast: vi.fn(async () => ({successCount: 0, failureCount: 0, responses: []}))},
    storage: {bucket: () => ({})},
    auth: {},
  };
});
vi.mock("../src/services/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyRestaurantClusterPack: vi.fn(async (input: Record<string, string>) => { packNotices.push(input); }),
  notifyCustomerRiderAssigned: vi.fn(async () => undefined),
  notifyRiderOffer: vi.fn(async () => undefined),
}));

import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
import {
  clusterCellsFor,
  clusterSettings,
  inOneClusterArea,
  itemCare,
  partCare,
  pickupOrder,
} from "../src/domain/clusterOrder";
import {calculateRiderTripPay, clusterStopTripPayPolicy, DEFAULT_RIDER_TRIP_PAY_POLICY} from "../src/domain/riderTripPay";
import type {SavrivoOrder} from "../src/types";
const {firestoreDb} = await import("../src/admin");
const clusters = await import("../src/services/clusterOrders");
const {assignClusterPart, beginSequentialDispatch} = await import("../src/services/dispatch");
const db = firestoreDb as unknown as InMemoryFirestore;

const UID = "familyuser000001";
// Naidupeta: a biryani house, a cafe 400 m away, an ice-cream parlour 600 m away; a dhaba 6 km out.
const PLACES = {
  biryani: {lat: 14.0350, lng: 79.9050, name: "Paradise Biryani", etaMin: 30, item: {id: "b1", name: "Chicken Biryani", price: 240}},
  meals: {lat: 14.0365, lng: 79.9040, name: "Annapurna Meals", etaMin: 20, item: {id: "m1", name: "Veg Meals", price: 120}},
  cafe: {lat: 14.0385, lng: 79.9055, name: "Brew Cafe", etaMin: 10, item: {id: "c1", name: "Filter Coffee", price: 40}},
  icecream: {lat: 14.0330, lng: 79.9095, name: "Polar Ice Cream", etaMin: 5, item: {id: "i1", name: "Kulfi Ice Cream", price: 60}},
  far: {lat: 14.0890, lng: 79.9050, name: "Highway Dhaba", etaMin: 25, item: {id: "f1", name: "Dal Fry", price: 150}},
} as const;
type Place = keyof typeof PLACES;

async function seed() {
  for (const [id, place] of Object.entries(PLACES)) {
    await db.collection("restaurants").doc(id).set({
      id, name: place.name, city: "Naidupeta", address: `${place.name}, Naidupeta`, lat: place.lat, lng: place.lng,
      open: true, deliveryFee: 30, etaMin: place.etaMin, etaMax: place.etaMin + 10, platformFee: 9,
      menu: [{...place.item, available: true, diet: "veg"}],
    });
  }
  await db.collection("users").doc(UID).set({name: "Ravi", phone: "9876543210", addresses: [
    {id: "home", label: "Home", address: "12 Gandhi Road", area: "Naidupeta", lat: 14.0400, lng: 79.9000, phone: "9876543210"},
  ]});
  await db.collection("settings").doc("customer").set({platformFee: 9, clusterStopFee: 20});
}
const part = (place: Place, quantity = 1) => ({restaurantId: place, items: [{itemId: PLACES[place].item.id, quantity}]});
const input = (places: Place[], key = "family-order-key-0001") =>
  ({idempotencyKey: key, addressId: "home", parts: places.map((p) => part(p)), couponCode: "", tip: 0, useWallet: false,
    deliveryMode: "asap" as const, instructions: "", contactless: false, paymentMethod: "cod" as const});
const order = async (id: string) => (await db.collection("orders").doc(id).get()).data() as SavrivoOrder;

beforeEach(async () => {
  (db as unknown as {store: Map<string, unknown>}).store.clear();
  packNotices.length = 0;
  rtdb.clear();
  await seed();
});

describe("which food goes first", () => {
  it("reads how carefully a dish has to travel from its name", () => {
    expect(["Chicken Biryani", "Veg Meals", "Idli Vada"].map(itemCare)).toEqual([0, 0, 1]);
    expect(["Masala Dosa", "French Fries", "Chicken Burger"].map(itemCare)).toEqual([1, 1, 1]);
    expect(["Filter Coffee", "Cold Coffee", "Mango Lassi", "Masala Chai"].map(itemCare)).toEqual([2, 2, 2, 2]);
    expect(["Kulfi Ice Cream", "Chocolate Sundae", "Gelato"].map(itemCare)).toEqual([3, 3, 3]);
    expect(partCare([{name: "Veg Meals"}, {name: "Butterscotch Ice-Cream"}])).toBe(3);
  });

  it("collects what keeps well first and what melts last; quick-pack kitchens later", () => {
    const parts = [
      {restaurantId: "icecream", lat: 0, lng: 0, care: 3 as const, kitchenMinutes: 5},
      {restaurantId: "cafe", lat: 0, lng: 0, care: 2 as const, kitchenMinutes: 10},
      {restaurantId: "meals", lat: 0, lng: 0, care: 0 as const, kitchenMinutes: 20},
      {restaurantId: "biryani", lat: 0, lng: 0, care: 0 as const, kitchenMinutes: 30},
    ];
    expect(pickupOrder(parts).map((p) => p.restaurantId)).toEqual(["biryani", "meals", "cafe", "icecream"]);
  });

  it("keeps an area to restaurants about 2 km apart, by hexagon", () => {
    expect(inOneClusterArea([PLACES.biryani, PLACES.cafe, PLACES.icecream])).toBe(true);
    expect(inOneClusterArea([PLACES.biryani, PLACES.far])).toBe(false);
    const cells = clusterCellsFor(PLACES.biryani.lat, PLACES.biryani.lng)!;
    expect(cells.clusterCells).toHaveLength(7);
    expect(cells.clusterCells).toContain(cells.clusterCell);
    expect(clusterCellsFor(0, 0)).toBeNull();
    expect(clusterSettings({})).toEqual({enabled: true, stopFee: 20, maxRestaurants: 4});
    expect(clusterSettings({clusterOrdersEnabled: false, clusterStopFee: 500, clusterMaxRestaurants: 9}))
      .toEqual({enabled: false, stopFee: 200, maxRestaurants: 5});
  });

  it("pays the rider a stop as a short extra ride, not a second trip", () => {
    const stop = calculateRiderTripPay(clusterStopTripPayPolicy(DEFAULT_RIDER_TRIP_PAY_POLICY, 600), {
      pickupMeters: 600, dropMeters: 0, waitMinutes: 0, minuteOfDay: 13 * 60});
    expect(stop.totalPaise).toBe(DEFAULT_RIDER_TRIP_PAY_POLICY.basePickupPaise);
    expect(stop.minimumTopUpPaise).toBe(0);
  });
});

describe("placing a family order", () => {
  it("prices the whole order: one delivery fee, a stop fee per extra restaurant", async () => {
    const preview = await clusters.previewClusterOrder(UID, input(["icecream", "cafe", "biryani"]));
    expect(preview.parts.map((p) => p.restaurantId)).toEqual(["biryani", "cafe", "icecream"]);
    expect(preview.parts.map((p) => p.careLabel)).toEqual(["Keeps well", "Drinks", "Melts fast"]);
    const [first, cafe, icecream] = preview.parts;
    expect(first!.pricing.deliveryFee).toBeGreaterThan(0);
    expect(first!.pricing.platformFee).toBe(9);
    for (const stop of [cafe!, icecream!]) {
      expect(stop.pricing.deliveryFee).toBe(20);
      expect(stop.pricing.platformFee).toBe(0);
    }
    expect(preview.subtotal).toBe(240 + 40 + 60);
    expect(preview.total).toBeCloseTo(preview.parts.reduce((sum, p) => sum + p.total, 0), 2);
  });

  it("places one order per restaurant, linked, with one delivery code; a retry returns the same order", async () => {
    const placed = await clusters.createClusterOrder(UID, input(["icecream", "cafe", "biryani"]));
    expect(placed.orders.map((o) => o.restaurantId)).toEqual(["biryani", "cafe", "icecream"]);
    expect(placed.deliveryOtp).toMatch(/^\d{4}$/);
    const saved = await Promise.all(placed.orders.map((o) => order(o.id)));
    expect(saved.map((o) => [o.cluster?.leg, o.cluster?.role, o.paymentMethod])).toEqual([[1, "anchor", "cod"], [2, "stop", "cod"], [3, "stop", "cod"]]);
    expect(saved.every((o) => o.cluster?.id === placed.clusterId && o.cluster?.stops.length === 3)).toBe(true);
    expect(saved[1]!.cluster?.stopKm).toBeGreaterThan(0);
    const otps = saved.map((o) => (db.read(`private/deliveryOtps/orders/${o.id}`) as {otp?: string} | null)?.otp);
    expect(new Set(otps)).toEqual(new Set([placed.deliveryOtp]));
    expect((await db.collection("orderClusters").doc(placed.clusterId).get()).data()).toMatchObject({status: "placed", size: 3});
    // Each restaurant sees its own part, with where it sits in the trip.
    const view = (await db.collection("restaurantOrders").where("restaurantId", "==", "icecream").get()).docs[0]?.data();
    expect(view?.cluster).toMatchObject({leg: 3, size: 3});
    const again = await clusters.createClusterOrder(UID, input(["icecream", "cafe", "biryani"]));
    expect(again.recovered).toBe(true);
    expect(again.orders.map((o) => o.id)).toEqual(placed.orders.map((o) => o.id));
    expect(again.deliveryOtp).toBe(placed.deliveryOtp);
  });

  it("charges exactly what the preview showed", async () => {
    const preview = await clusters.previewClusterOrder(UID, input(["cafe", "biryani", "icecream"]));
    const placed = await clusters.createClusterOrder(UID, input(["cafe", "biryani", "icecream"], "family-order-key-0003"));
    expect(placed.orders.map((o) => o.total)).toEqual(preview.parts.map((p) => p.total));
    expect(placed.orders.map((o) => o.pricing)).toEqual(preview.parts.map((p) => p.pricing));
  });

  it("refuses restaurants too far apart for one rider, and the same restaurant twice", async () => {
    await expect(clusters.createClusterOrder(UID, input(["biryani", "far"]))).rejects.toThrow(/too far apart/);
    await expect(clusters.previewClusterOrder(UID, input(["biryani", "biryani"]))).rejects.toThrow(/once/);
    await db.collection("settings").doc("customer").set({clusterOrdersEnabled: false});
    await expect(clusters.previewClusterOrder(UID, input(["biryani", "cafe"]))).rejects.toThrow(/switched off/);
  });

  it("withdraws the parts of an order interrupted while being placed", async () => {
    const placed = await clusters.createClusterOrder(UID, input(["biryani", "cafe"]));
    await db.collection("orderClusters").doc(placed.clusterId).set({status: "placing", createdAt: Date.now() - 10 * 60_000}, {merge: true});
    expect(await clusters.sweepUnfinishedClusterOrders()).toBe(1);
    const parts = await Promise.all(placed.orders.map((o) => order(o.id)));
    expect(parts.map((o) => o.status)).toEqual(["Cancelled", "Cancelled"]);
    await expect(clusters.createClusterOrder(UID, input(["biryani", "cafe"]))).rejects.toThrow(/didn't go through/);
  });
});

describe("one rider for the whole order", () => {
  async function placedAndAccepted() {
    const placed = await clusters.createClusterOrder(UID, input(["icecream", "cafe", "biryani"], "family-order-key-0002"));
    for (const o of placed.orders) {
      const current = await order(o.id);
      await db.collection("orders").doc(o.id).set({...current, status: "Accepted", updatedAt: Date.now()});
    }
    await db.collection("riders").doc("riderRaju00000001").set({fullName: "Raju", phone: "9000000001", status: "approved"});
    return placed;
  }

  it("gives every accepted part to the rider found for the first pickup, without offering them on their own", async () => {
    const placed = await placedAndAccepted();
    const [lead, cafe, icecream] = placed.orders;
    // The ice-cream part is accepted but nobody has the trip yet: it waits, no offer of its own.
    expect(await beginSequentialDispatch(await order(icecream!.id))).toBeNull();
    expect((await db.collection("dispatchQueue").doc(icecream!.id).get()).exists).toBe(false);
    // The rider takes the first pickup; the other parts follow them.
    await db.collection("orders").doc(lead!.id).set({...(await order(lead!.id)), riderId: "riderRaju00000001", status: "Accepted"});
    await assignClusterPart(cafe!.id, "riderRaju00000001");
    expect(await beginSequentialDispatch(await order(icecream!.id))).toBeNull();
    for (const o of [cafe!, icecream!]) {
      const saved = await order(o.id);
      expect(saved.riderId).toBe("riderRaju00000001");
      expect(saved.riderName).toBe("Raju");
      expect((await db.collection("riderJobs").doc(`riderRaju00000001_${o.id}`).get()).data())
        .toMatchObject({orderId: o.id, riderId: "riderRaju00000001"});
      expect(rtdb.get(`feastly/trackingAssignments/${o.id}`)).toMatchObject({riderId: "riderRaju00000001"});
    }
    // Repeating is harmless.
    expect((await assignClusterPart(cafe!.id, "someoneElse0000001"))?.riderId).toBe("riderRaju00000001");
  });

  it("tells the next restaurant to pack when the rider leaves the previous one", async () => {
    const placed = await placedAndAccepted();
    const [lead, cafe] = placed.orders;
    const before = await order(lead!.id);
    await clusters.onClusterPartStatus({...before, status: "Assigned"}, {...before, status: "Handed to rider"});
    expect(packNotices).toEqual([expect.objectContaining({restaurantId: "cafe", orderId: cafe!.id, title: "Rider on the way: pack now"})]);
    expect(packNotices[0]!.body).toMatch(/Paradise Biryani.*pickup 2 of 3/);
  });

  it("lets the next part find the rider when the first pickup is cancelled before one is found", async () => {
    const placed = await placedAndAccepted();
    const [lead, cafe] = placed.orders;
    const before = await order(lead!.id);
    const promoted = await clusters.onClusterPartStatus(before, {...before, status: "Cancelled"});
    expect(promoted?.id).toBe(cafe!.id);
    expect((await order(cafe!.id)).cluster?.leadSince).toBeGreaterThan(0);
    expect(clusters.leadsCluster(await order(cafe!.id))).toBe(true);
  });

  it("sends the customer trip updates once, from the part leading the trip", async () => {
    const placed = await placedAndAccepted();
    const [lead, cafe] = placed.orders;
    expect(clusters.quietClusterTripUpdate({...(await order(cafe!.id)), status: "Out for delivery"})).toBe(true);
    expect(clusters.quietClusterTripUpdate({...(await order(cafe!.id)), status: "Preparing"})).toBe(false);
    expect(clusters.quietClusterTripUpdate({...(await order(lead!.id)), status: "Out for delivery"})).toBe(false);
  });
});
