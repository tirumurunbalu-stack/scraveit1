import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {
    collection: () => {
      throw new Error("TEST_DB_NOT_AVAILABLE");
    },
  },
}));

import {DomainError} from "../src/errors";
import {requiresVerifiedOnlinePaymentBeforeProgress} from "../src/services/orders";
import {
  canonicalPaymentRef,
  initiatePayment,
  type PaymentDatabase,
  type PaymentGateway,
} from "../src/services/payments";
import type {SavrivoOrder} from "../src/types";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

class MemoryDatabase extends InMemoryFirestore implements PaymentDatabase {}

function orderPath(orderId: string): string {
  return `orders/${orderId}`;
}

function paymentAttemptPath(orderId: string, attemptId: string): string {
  return `paymentAttempts/${orderId}/attempts/${attemptId}`;
}

function sampleOrder(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: "SV-ORDER-001",
    schemaVersion: 3,
    idempotencyKey: "idem_test_key_123456",
    customerId: "customer-1",
    customerName: "Customer One",
    customerPhone: "9999999999",
    restaurantId: "restaurant-1",
    restaurant: "The Waffle Spot",
    restaurantLocation: {address: "Main road", lat: 14.9, lng: 79.9},
    items: [{
      itemId: "item-1",
      name: "Waffle",
      quantity: 1,
      price: 129,
      variant: "",
      variantPrice: 0,
      addOns: [],
      addOnTotal: 0,
      note: "",
      diet: "veg",
    }],
    pricing: {
      subtotal: 129,
      discount: 0,
      deliveryFee: 20,
      smallOrderFee: 0,
      lateNightFee: 0,
      rainFee: 0,
      surgeFee: 0,
      riderIncentiveFee: 0,
      platformFee: 5,
      tax: 6,
      tip: 10,
      currency: "INR",
      source: "catalog_snapshot_v3",
    },
    pricingContext: {
      distanceKm: 2.4,
      platformFeeRule: "server_authoritative",
      weatherSeverity: "",
      surgeActiveOrders: 0,
      pricedAt: 1_000,
    },
    total: 170,
    coupon: "",
    paymentMethod: "upi",
    paymentProvider: "phonepe",
    paymentState: "pending",
    deliveryMode: "asap",
    address: {
      id: "addr-1",
      label: "Home",
      area: "Town",
      address: "Door 1",
      phone: "9999999999",
      source: "manual",
      updatedAt: 1_000,
      lat: 14.91,
      lng: 79.91,
      city: "Nellore",
    },
    instructions: "",
    contactless: false,
    status: "Order placed",
    statusHistory: {
      e_1_customer: {
        status: "Order placed",
        at: 1_000,
        actorId: "customer-1",
        actorRole: "customer",
      },
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    etaMin: 25,
    etaMax: 35,
    ...overrides,
  };
}

describe("initiatePayment", () => {
  const now = 1_700_000_000_000;
  let database: MemoryDatabase;
  let createIntentCalls: string[];
  let gateway: PaymentGateway;

  beforeEach(() => {
    database = new MemoryDatabase();
    createIntentCalls = [];
    gateway = {
      provider: "phonepe",
      configured: true,
      async createIntent(_order, request) {
        createIntentCalls.push(request.merchantOrderId);
        return {
          provider: "phonepe",
          merchantOrderId: request.merchantOrderId,
          redirectUrl: `upi://pay?tr=${request.merchantOrderId}`,
          expiresAt: now + 15 * 60_000,
        };
      },
      async verifyWebhook() {
        return {verified: false, reason: "NOT_USED_IN_TEST"};
      },
    };
  });

  it("starts a UPI payment and writes the canonical attempt once", async () => {
    const order = sampleOrder({paymentMethod: "upi"});
    database.seed(orderPath(order.id), order);

    const intent = await initiatePayment(order.customerId, {
      customerId: order.customerId,
      orderId: order.id,
      provider: "phonepe",
    }, gateway, database, () => now);

    expect(intent.provider).toBe("phonepe");
    expect(intent.redirectUrl).toContain("upi://pay");
    expect(createIntentCalls).toHaveLength(1);
    expect(database.read(canonicalPaymentRef(database, order.id).path)).toBeTruthy();
  });

  it("allows card orders to use the same verified online-payment flow", async () => {
    const order = sampleOrder({
      id: "SV-ORDER-002",
      paymentMethod: "card",
      paymentState: "pending",
    });
    database.seed(orderPath(order.id), order);

    const intent = await initiatePayment(order.customerId, {
      customerId: order.customerId,
      orderId: order.id,
      provider: "phonepe",
    }, gateway, database, () => now);

    expect(intent.merchantOrderId).toMatch(/^SVPAY_/);
    expect(createIntentCalls).toHaveLength(1);
  });

  it("reuses the active attempt instead of creating a second one", async () => {
    const order = sampleOrder();
    database.seed(orderPath(order.id), order);

    const first = await initiatePayment(order.customerId, {
      customerId: order.customerId,
      orderId: order.id,
      provider: "phonepe",
    }, gateway, database, () => now);
    const second = await initiatePayment(order.customerId, {
      customerId: order.customerId,
      orderId: order.id,
      provider: "phonepe",
    }, gateway, database, () => now + 30_000);

    expect(second.merchantOrderId).toBe(first.merchantOrderId);
    expect(createIntentCalls).toHaveLength(1);
    expect(database.read(paymentAttemptPath(order.id, first.merchantOrderId))).toBeTruthy();
  });

  it("rejects COD orders from starting an online payment attempt", async () => {
    const order = sampleOrder({
      id: "SV-ORDER-003",
      paymentMethod: "cod",
      paymentState: "cash_due",
      paymentProvider: undefined,
    });
    database.seed(orderPath(order.id), order);

    await expect(() => initiatePayment(order.customerId, {
      customerId: order.customerId,
      orderId: order.id,
      provider: "phonepe",
    }, gateway, database, () => now)).rejects.toBeInstanceOf(DomainError);
  });
});

describe("requiresVerifiedOnlinePaymentBeforeProgress", () => {
  it("blocks unpaid online orders but not paid online orders or COD orders", () => {
    expect(requiresVerifiedOnlinePaymentBeforeProgress({
      paymentMethod: "upi",
      paymentState: "pending",
    }, "Accepted")).toBe(true);
    expect(requiresVerifiedOnlinePaymentBeforeProgress({
      paymentMethod: "card",
      paymentState: "paid",
    }, "Accepted")).toBe(false);
    expect(requiresVerifiedOnlinePaymentBeforeProgress({
      paymentMethod: "cod",
      paymentState: "cash_due",
    }, "Accepted")).toBe(false);
    expect(requiresVerifiedOnlinePaymentBeforeProgress({
      paymentMethod: "upi",
      paymentState: "failed",
    }, "Cancelled")).toBe(false);
  });
});
