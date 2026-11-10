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
import {buildRestaurantOrderProjection} from "../src/domain/restaurantOrder";
import {buildOnlineOrderDeliveryJournal} from "../src/services/ledger";
import {assignStoreAsRider, completeStoreDeliveryFromChat, transitionOrder} from "../src/services/orders";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const database = firestoreDb as unknown as InMemoryFirestore;

const customerId = "customer-1";
const orderId = "SV-STORE-DELIVERY-1";
const restaurantId = "the-waffle-spot";
const storeRider = `store_${restaurantId}`;
const token = {uid: "owner-1", email: "owner@example.com"} as unknown as DecodedIdToken;

function order(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: orderId,
    schemaVersion: 3,
    idempotencyKey: "store-delivery-1",
    customerId,
    customerName: "Ravi",
    customerPhone: "9000000000",
    restaurantId,
    restaurant: "The Waffle Spot",
    restaurantLocation: {address: "Main road", lat: 13.9, lng: 79.9},
    selfDelivery: true,
    items: [],
    pricing: {
      subtotal: 200, discount: 0, deliveryFee: 30, smallOrderFee: 0, lateNightFee: 0,
      rainFee: 0, surgeFee: 0, platformFee: 5, tax: 10, tip: 10, currency: "INR",
      source: "catalog_snapshot_v3",
    },
    pricingContext: {distanceKm: 2, platformFeeRule: "test", weatherSeverity: "none", surgeActiveOrders: 0, pricedAt: 1_000},
    total: 255,
    coupon: "",
    paymentMethod: "upi",
    paymentState: "paid",
    deliveryMode: "asap",
    address: {
      id: "home", label: "Home", area: "LA Sagaram", address: "1-1-277, Mangapathi Naidu Nagar",
      phone: "9000000000", source: "gps", lat: 13.91, lng: 79.91, updatedAt: 1_000,
      house: "Door 4, first floor", landmark: "Opposite the temple",
    },
    instructions: "",
    contactless: false,
    status: "Accepted",
    statusHistory: {accepted: {status: "Accepted", at: 1_500, actorId: "owner-1", actorRole: "staff"}},
    createdAt: 1_000,
    updatedAt: 1_500,
    etaMin: 25,
    etaMax: 35,
    economics: {
      rider: {deliveryPayPaise: 3_500, feeSharePaise: 0},
      customer: {tipPaise: 1_000},
    },
    ...overrides,
  } as unknown as SavrivoOrder;
}

function storeChat(): Array<Record<string, unknown>> {
  return database.paths()
    .filter((path) => path.startsWith("orderChats/"))
    .map((path) => database.read(path) as Record<string, unknown>);
}

function stored(): SavrivoOrder {
  return database.read(`orders/${orderId}`) as SavrivoOrder;
}

describe("store self-delivery", () => {
  beforeEach(async () => {
    for (const path of database.paths()) await database.doc(path).delete();
  });

  it("takes the delivery for the store and gives it the address and its pay in the private chat", async () => {
    database.seed(`orders/${orderId}`, order());

    const result = await assignStoreAsRider(order());

    expect(result).toMatchObject({riderId: storeRider, riderName: "The Waffle Spot", status: "Accepted"});
    const [note] = storeChat();
    expect(note).toMatchObject({channel: "restaurantRider", restaurantId, riderId: storeRider, senderRole: "Scraveit"});
    expect(note.body).toContain("Door 4, first floor, 1-1-277, Mangapathi Naidu Nagar, LA Sagaram");
    expect(note.body).toContain("Landmark: Opposite the temple");
    expect(note.body).toContain("https://maps.google.com/?q=13.91,79.91");
    expect(note.body).toContain("Your delivery pay: ₹35 + ₹10 tip");
  });

  it("leaves orders of stores that use riders alone", async () => {
    const riderOrder = order({selfDelivery: undefined});
    database.seed(`orders/${orderId}`, riderOrder);
    expect(await assignStoreAsRider(riderOrder)).toBe(riderOrder);
    expect(stored().riderId).toBeUndefined();
    expect(storeChat()).toHaveLength(0);
  });

  it("unlocks the handover button for the store without a rider arrival check", () => {
    expect(buildRestaurantOrderProjection(order({riderId: storeRider, status: "Assigned"})).riderArrivalVerified).toBe(true);
    expect(buildRestaurantOrderProjection(order({riderId: "rider-1", selfDelivery: undefined, status: "Assigned"}))
      .riderArrivalVerified).toBeUndefined();
  });

  it("puts the order out for delivery when the store confirms handover", async () => {
    database.seed(`orders/${orderId}`, order({
      status: "Assigned", riderId: storeRider, riderName: "The Waffle Spot", riderAssignedAt: 1_600,
    }));
    const result = await transitionOrder("owner-1", token, {
      customerId, orderId, toStatus: "Handed to rider", reason: "", cashCollected: false,
    });
    expect(result.order.status).toBe("Out for delivery");
    expect(stored().status).toBe("Out for delivery");
  });

  it("delivers when the store types the customer's code, and refuses a wrong one", async () => {
    database.seed(`orders/${orderId}`, order({status: "Out for delivery", riderId: storeRider}));
    database.seed(`private/deliveryOtps/orders/${orderId}`, {customerId, otp: "4321", salt: "ab".repeat(16), createdAt: 1, updatedAt: 1});

    expect(await completeStoreDeliveryFromChat({orderId, senderRole: "restaurant", body: "code 1234"})).toBe("wrong_code");
    expect(stored().status).toBe("Out for delivery");
    expect(await completeStoreDeliveryFromChat({orderId, senderRole: "customer", body: "4321"})).toBe("ignored");
    expect(await completeStoreDeliveryFromChat({orderId, senderRole: "restaurant", body: "on my way"})).toBe("ignored");

    expect(await completeStoreDeliveryFromChat({orderId, senderRole: "restaurant", body: "4321"})).toBe("delivered");
    expect(stored().status).toBe("Delivered");
    const proofs = Object.values(stored().statusHistory ?? {}).filter((event) => event.status === "Delivered");
    expect(proofs).toMatchObject([{proof: "otp", actorId: storeRider}]);
    expect(storeChat().map((message) => String(message.body))).toEqual(expect.arrayContaining([
      expect.stringContaining("didn't match"),
      "Delivered. ₹45 delivery pay is added to your payout.",
    ]));
  });

  it("pays the rider's share into the store's payout instead of a rider account", () => {
    const journal = buildOnlineOrderDeliveryJournal({
      orderId, restaurantId, riderId: storeRider, occurredAt: 5_000,
      paymentProvider: "cashfree", providerTransactionId: "txn-1",
      grossAmountPaise: 25_500, restaurantPayablePaise: 17_000, platformCommissionPaise: 2_000,
      platformFeePaise: 1_500, taxPayablePaise: 500, riderDeliveryEarningPaise: 3_500, riderTipPaise: 1_000,
      storeDelivered: true,
    });
    const credits = journal.entries.filter((entry) => entry.side === "credit");
    expect(credits.some((entry) => entry.accountId.includes("rider"))).toBe(false);
    const storePayable = credits
      .filter((entry) => entry.accountId === `liability:restaurant-payable:${restaurantId}`)
      .reduce((total, entry) => total + entry.amountPaise, 0);
    expect(storePayable).toBe(17_000 + 3_500 + 1_000);
  });
});
