import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../admin", () => ({
  db: {
    ref: () => {
      throw new Error("TEST_DB_NOT_AVAILABLE");
    },
  },
}));

import {pathFor, ROOT} from "../config";
import {DomainError} from "../errors";
import {requiresVerifiedOnlinePaymentBeforeProgress} from "./orders";
import {
  canonicalPaymentPath,
  initiatePayment,
  type PaymentDatabase,
  type PaymentGateway,
} from "./payments";
import type {SavrivoOrder} from "../types";

class MemorySnapshot {
  constructor(private readonly value: unknown) {}

  val(): unknown {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
}

class MemoryRef {
  constructor(
    private readonly store: Record<string, unknown>,
    private readonly segments: readonly string[],
  ) {}

  async get(): Promise<{val(): unknown}> {
    return new MemorySnapshot(readAt(this.store, this.segments));
  }

  async update(values: Record<string, unknown>): Promise<void> {
    for (const [relativePath, value] of Object.entries(values ?? {})) {
      writeAt(this.store, [...this.segments, ...pathSegments(relativePath)], value);
    }
  }

  async transaction(
    update: (current: unknown) => unknown,
  ): Promise<{committed: boolean; snapshot: {val(): unknown}}> {
    const current = readAt(this.store, this.segments);
    const next = update(current);
    if (next === undefined) {
      return {committed: false, snapshot: new MemorySnapshot(current)};
    }
    writeAt(this.store, this.segments, next);
    return {committed: true, snapshot: new MemorySnapshot(next)};
  }
}

class MemoryDatabase implements PaymentDatabase {
  readonly data: Record<string, unknown>;

  constructor(seed?: Record<string, unknown>) {
    this.data = structuredClone(seed ?? {}) as Record<string, unknown>;
  }

  ref(path: string): MemoryRef {
    return new MemoryRef(this.data, pathSegments(path));
  }
}

function pathSegments(path: string): string[] {
  return String(path ?? "").split("/").filter(Boolean);
}

function readAt(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? undefined : structuredClone(current);
}

function writeAt(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  if (!segments.length) return;
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1] as string] = value === undefined ? null : structuredClone(value);
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
    writeAt(database.data, pathSegments(pathFor.order(order.customerId, order.id)), order);

    const intent = await initiatePayment(order.customerId, {
      customerId: order.customerId,
      orderId: order.id,
      provider: "phonepe",
    }, gateway, database, () => now);

    expect(intent.provider).toBe("phonepe");
    expect(intent.redirectUrl).toContain("upi://pay");
    expect(createIntentCalls).toHaveLength(1);
    expect(readAt(database.data, pathSegments(canonicalPaymentPath(order.id)))).toBeTruthy();
  });

  it("allows card orders to use the same verified online-payment flow", async () => {
    const order = sampleOrder({
      id: "SV-ORDER-002",
      paymentMethod: "card",
      paymentState: "pending",
    });
    writeAt(database.data, pathSegments(pathFor.order(order.customerId, order.id)), order);

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
    writeAt(database.data, pathSegments(pathFor.order(order.customerId, order.id)), order);

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
    expect(readAt(database.data, pathSegments(`${ROOT}/paymentAttempts/${order.id}/${first.merchantOrderId}`))).toBeTruthy();
  });

  it("rejects COD orders from starting an online payment attempt", async () => {
    const order = sampleOrder({
      id: "SV-ORDER-003",
      paymentMethod: "cod",
      paymentState: "cash_due",
      paymentProvider: undefined,
    });
    writeAt(database.data, pathSegments(pathFor.order(order.customerId, order.id)), order);

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
