import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SavrivoOrder} from "../src/types";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore(), db: {}};
});

vi.mock("../src/services/authz", () => ({
  authorizeTransition: vi.fn(async () => "staff"),
  requireApprovedRider: vi.fn(async () => ({status: "approved"})),
}));

vi.mock("../src/services/orderProjection", () => ({
  reconcileRestaurantOrderProjection: vi.fn(async () => undefined),
}));

vi.mock("../src/services/workload", () => ({
  reconcileRestaurantWorkload: vi.fn(async () => undefined),
}));

const stored = new Map<string, {size: number; contentType: string}>();
vi.mock("../src/services/mediaBucket", () => ({
  mediaFile: vi.fn(async (path: string) => ({
    exists: async () => [stored.has(path)],
    getMetadata: async () => [stored.get(path)],
    getSignedUrl: async () => [`https://signed.example/${path}`],
  })),
}));

import {firestoreDb} from "../src/admin";
import {transitionOrder} from "../src/services/orders";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const database = firestoreDb as unknown as InMemoryFirestore;

const customerId = "customer-1";
const orderId = "482915736104829";
const restaurantId = "restaurant-1";
const riderId = "rider-1";
const token = {uid: riderId} as unknown as DecodedIdToken;
const photoPath = `private/rider-pickups/${riderId}/${orderId}-1767000000000.jpg`;
const pickup = (pickupPhotoPath: string) => ({
  customerId,
  orderId,
  toStatus: "Handed to rider" as const,
  reason: "",
  cashCollected: false,
  pickupPhotoPath,
});

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
    customerPhone: "9876543210",
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

describe("rider pickup with a parcel photo", () => {
  beforeEach(async () => {
    for (const path of database.paths()) await database.doc(path).delete();
    database.seed(orderPath(orderId), assignedOrder());
    database.seed(arrivalPath(orderId), verifiedArrival());
    stored.clear();
    stored.set(photoPath, {size: 400_000, contentType: "image/jpeg"});
  });

  it("hands the order to the rider who photographs the parcel", async () => {
    const result = await transitionOrder(riderId, token, pickup(photoPath));
    expect(result).toMatchObject({actorRole: "rider", idempotent: false, order: {status: "Handed to rider", riderId}});
    const saved = database.read(orderPath(orderId)) as SavrivoOrder & {pickupPhoto?: {path: string; by: string}};
    expect(Object.values(saved.statusHistory).find((event) => event.status === "Handed to rider"))
      .toMatchObject({actorId: riderId, actorRole: "rider", proof: "parcel_photo"});
    expect(saved.pickupPhoto).toMatchObject({path: photoPath, by: riderId});
  });

  it("keeps the order with the restaurant when the photo never uploaded", async () => {
    stored.clear();
    await expect(transitionOrder(riderId, token, pickup(photoPath))).rejects.toThrow("The photo didn't finish uploading.");
    expect(database.read(orderPath(orderId))).toMatchObject({status: "Assigned"});
  });

  it("refuses a photo from another rider's or another order's folder", async () => {
    await expect(transitionOrder(riderId, token, pickup(`private/rider-pickups/rider-2/${orderId}-1767000000000.jpg`)))
      .rejects.toThrow("That photo can't be used for this order.");
    await expect(transitionOrder(riderId, token, pickup(`private/rider-pickups/${riderId}/999-1767000000000.jpg`)))
      .rejects.toThrow("That photo can't be used for this order.");
  });

  it("refuses a file that isn't a photo", async () => {
    stored.set(photoPath, {size: 400_000, contentType: "application/pdf"});
    await expect(transitionOrder(riderId, token, pickup(photoPath))).rejects.toThrow("That file isn't a photo we can use.");
  });

  it("lets only the assigned rider pick up", async () => {
    await expect(transitionOrder("rider-2", {uid: "rider-2"} as unknown as DecodedIdToken, pickup(photoPath)))
      .rejects.toThrow("Only the delivery partner on this order can pick it up.");
  });

  it("still needs the rider's verified arrival at the restaurant", async () => {
    await database.doc(arrivalPath(orderId)).delete();
    await expect(transitionOrder(riderId, token, pickup(photoPath))).rejects.toThrow("verified restaurant arrival");
  });

  it("picks up an order the kitchen never marked ready", async () => {
    database.seed(orderPath(orderId), {...assignedOrder(), status: "Preparing"});
    const result = await transitionOrder(riderId, token, pickup(photoPath));
    expect(result.order).toMatchObject({status: "Handed to rider", riderId});
    const saved = database.read(orderPath(orderId)) as SavrivoOrder;
    expect(Object.values(saved.statusHistory).map((event) => event.status))
      .toEqual(expect.arrayContaining(["Ready for pickup", "Assigned", "Handed to rider"]));
  });

  it("picks up a ready order whose rider was never confirmed", async () => {
    database.seed(orderPath(orderId), {...assignedOrder(), status: "Ready for pickup"});
    const result = await transitionOrder(riderId, token, pickup(photoPath));
    expect(result.order).toMatchObject({status: "Handed to rider", riderId});
  });

  it("leaves a preparing order alone when the rider isn't verified at the restaurant", async () => {
    database.seed(orderPath(orderId), {...assignedOrder(), status: "Preparing"});
    await database.doc(arrivalPath(orderId)).delete();
    await expect(transitionOrder(riderId, token, pickup(photoPath))).rejects.toThrow("verified restaurant arrival");
    expect(database.read(orderPath(orderId))).toMatchObject({status: "Preparing"});
  });

  it("doesn't let a rider skip the kitchen without a photo", async () => {
    database.seed(orderPath(orderId), {...assignedOrder(), status: "Preparing"});
    const {authorizeTransition} = await import("../src/services/authz");
    vi.mocked(authorizeTransition).mockResolvedValueOnce("rider");
    await expect(transitionOrder(riderId, token, {...pickup(photoPath), pickupPhotoPath: undefined}))
      .rejects.toThrow("Cannot change Preparing to Handed to rider.");
  });

  it("leaves a store's own delivery to the store", async () => {
    database.seed(orderPath(orderId), {...assignedOrder(), selfDelivery: true});
    await expect(transitionOrder(riderId, token, pickup(photoPath))).rejects.toThrow("Only the delivery partner on this order can pick it up.");
  });
});
