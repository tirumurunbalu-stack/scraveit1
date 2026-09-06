import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }},
}));

import {hydrateLegacyPayment, type PaymentAggregate, type PaymentTransitionEvent} from "../src/domain/paymentState";
import {
  buildOnlineOrderDeliveryJournal,
  buildOnlinePaymentReceiptJournal,
  LEDGER_JOURNALS_ROOT,
  ledgerJournalPath,
  orderDeliveryAmounts,
  type LedgerTransactionResult,
} from "../src/services/ledger";
import {
  persistOnlineOrderDeliveryLedger,
  type OnlineDeliveryLedgerDatabase,
} from "../src/services/onlineDeliveryLedger";
import {canonicalPaymentPath} from "../src/services/payments";
import type {SavrivoOrder} from "../src/types";

class InMemoryOnlineLedgerDatabase implements OnlineDeliveryLedgerDatabase {
  private readonly values = new Map<string, unknown>();

  seed(path: string, value: unknown): void {
    this.values.set(path, structuredClone(value));
  }

  value<T>(path: string): T | null {
    return (this.values.get(path) as T | undefined) ?? null;
  }

  paths(prefix: string): string[] {
    return [...this.values.keys()].filter((path) => path.startsWith(prefix)).sort();
  }

  ref(path: string) {
    return {
      get: async () => ({val: () => this.values.get(path) ?? null}),
      transaction: async (update: (current: unknown) => unknown): Promise<LedgerTransactionResult> => {
        const next = update(this.values.get(path) ?? null);
        if (next === undefined) {
          return {committed: false, snapshot: {val: () => this.values.get(path) ?? null}};
        }
        this.values.set(path, structuredClone(next));
        return {committed: true, snapshot: {val: () => this.values.get(path) ?? null}};
      },
    };
  }
}

function deliveredOnlineOrder(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: "SV-ONLINE-DELIVERY-1",
    schemaVersion: 3,
    idempotencyKey: "checkout-online-delivery-1",
    customerId: "customer-1",
    customerName: "Customer",
    customerPhone: "9000000000",
    restaurantId: "restaurant-1",
    restaurant: "Restaurant",
    restaurantLocation: {address: "Restaurant address", lat: 13.9, lng: 79.9},
    items: [{
      itemId: "item-1",
      name: "Item",
      quantity: 1,
      price: 100,
      variant: "",
      variantPrice: 0,
      addOns: [],
      addOnTotal: 0,
      note: "",
      diet: "veg",
    }],
    pricing: {
      subtotal: 100,
      discount: 0,
      deliveryFee: 10,
      smallOrderFee: 0,
      lateNightFee: 0,
      rainFee: 0,
      surgeFee: 0,
      platformFee: 5,
      tax: 6,
      tip: 0,
      currency: "INR",
      source: "catalog_snapshot_v3",
    },
    pricingContext: {
      distanceKm: 1,
      platformFeeRule: "test",
      weatherSeverity: "none",
      surgeActiveOrders: 0,
      pricedAt: 1_000,
    },
    total: 121,
    coupon: "",
    paymentMethod: "upi",
    paymentState: "paid",
    paymentPhase: "paid",
    terminalPhase: "delivered",
    deliveryMode: "asap",
    address: {
      id: "address-1",
      label: "Home",
      area: "Area",
      address: "Customer address",
      phone: "9000000000",
      source: "manual",
      lat: 13.91,
      lng: 79.91,
      updatedAt: 1_000,
    },
    instructions: "",
    contactless: false,
    status: "Delivered",
    statusHistory: {},
    riderId: "rider-1",
    createdAt: 1_000,
    updatedAt: 4_000,
    deliveredAt: 4_000,
    etaMin: 20,
    etaMax: 30,
    ...overrides,
  };
}

function paidAggregate(order: SavrivoOrder, overrides: Partial<PaymentAggregate> = {}): PaymentAggregate {
  return {
    ...hydrateLegacyPayment({
      paymentId: `payment:${order.id}`,
      orderId: order.id,
      customerId: order.customerId,
      method: order.paymentMethod === "card" ? "card" : "upi",
      provider: "phonepe",
      amountPaise: Math.round(order.total * 100),
      createdAt: 1_500,
      legacyState: "paid",
      revision: 1,
      attemptSequence: 1,
      currentAttemptId: "attempt-1",
      updatedAt: 2_000,
    }),
    ...overrides,
  };
}

function paidEvent(aggregate: PaymentAggregate, overrides: Partial<PaymentTransitionEvent> = {}): PaymentTransitionEvent {
  return {
    schemaVersion: 1,
    eventId: "gateway:phonepe:paid-1",
    paymentId: aggregate.paymentId,
    orderId: aggregate.orderId,
    previousState: "pending",
    newState: "paid",
    actor: {role: "gateway", id: "phonepe"},
    occurredAt: aggregate.updatedAt,
    revision: aggregate.revision,
    attemptId: aggregate.currentAttemptId,
    providerReference: "phonepe-transaction-1",
    ...overrides,
  };
}

function seedVerifiedPayment(
  database: InMemoryOnlineLedgerDatabase,
  order: SavrivoOrder,
  aggregate: PaymentAggregate = paidAggregate(order),
  event: PaymentTransitionEvent = paidEvent(aggregate),
): void {
  database.seed(canonicalPaymentPath(order.id), {
    schemaVersion: 1,
    aggregate,
    attempts: {},
    operations: {},
    events: {[event.eventId]: event},
  });
  const receipt = buildOnlinePaymentReceiptJournal({
    paymentId: aggregate.paymentId,
    orderId: order.id,
    paymentProvider: String(aggregate.provider),
    providerTransactionId: String(event.providerReference),
    amountPaise: aggregate.amountPaise,
    occurredAt: event.occurredAt,
  });
  database.seed(ledgerJournalPath(receipt), receipt);
}

describe("verified online delivery ledger release", () => {
  it("releases held online funds to the configured delivery liabilities", async () => {
    const database = new InMemoryOnlineLedgerDatabase();
    const order = deliveredOnlineOrder();
    seedVerifiedPayment(database, order);

    const result = await persistOnlineOrderDeliveryLedger(order, 1_500, database);
    const expected = buildOnlineOrderDeliveryJournal({
      ...orderDeliveryAmounts(order, 1_500),
      orderId: order.id,
      restaurantId: order.restaurantId,
      riderId: String(order.riderId),
      occurredAt: Number(order.deliveredAt),
      paymentProvider: "phonepe",
      providerTransactionId: "phonepe-transaction-1",
    });

    expect(result).toMatchObject({outcome: "insert", path: ledgerJournalPath(expected)});
    expect(database.value(ledgerJournalPath(expected))).toEqual(expected);
    expect(expected.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: `liability:customer-order-funds:${order.id}`,
        side: "debit",
        amountPaise: 12_100,
      }),
      expect.objectContaining({accountId: `liability:restaurant-payable:${order.restaurantId}`}),
      expect.objectContaining({accountId: `liability:rider-earnings:${order.riderId}`}),
      expect.objectContaining({accountId: "revenue:platform-commission"}),
      expect.objectContaining({accountId: "revenue:platform-fees"}),
    ]));
  });

  it("is idempotent when the Delivered trigger is delivered twice", async () => {
    const database = new InMemoryOnlineLedgerDatabase();
    const order = deliveredOnlineOrder();
    seedVerifiedPayment(database, order);

    await expect(persistOnlineOrderDeliveryLedger(order, 1_500, database))
      .resolves.toMatchObject({outcome: "insert"});
    await expect(persistOnlineOrderDeliveryLedger(order, 1_500, database))
      .resolves.toMatchObject({outcome: "idempotent"});

    const journals = database.paths(`${LEDGER_JOURNALS_ROOT}/`);
    expect(journals).toHaveLength(2); // one verified receipt plus one delivery release
  });

  it("rejects unpaid canonical records even if the public order claims paid", async () => {
    const database = new InMemoryOnlineLedgerDatabase();
    const order = deliveredOnlineOrder();
    const aggregate = hydrateLegacyPayment({
      paymentId: `payment:${order.id}`,
      orderId: order.id,
      customerId: order.customerId,
      method: "upi",
      provider: "phonepe",
      amountPaise: 12_100,
      createdAt: 1_500,
      legacyState: "pending",
      revision: 1,
      attemptSequence: 1,
      currentAttemptId: "attempt-1",
      updatedAt: 2_000,
    });
    database.seed(canonicalPaymentPath(order.id), {
      schemaVersion: 1,
      aggregate,
      attempts: {},
      operations: {},
      events: {},
    });

    await expect(persistOnlineOrderDeliveryLedger(order, 1_500, database))
      .rejects.toThrow("LEDGER_ONLINE_PAYMENT_NOT_VERIFIED_PAID");
  });

  it("rejects a paid projection without its immutable verified gateway receipt", async () => {
    const database = new InMemoryOnlineLedgerDatabase();
    const order = deliveredOnlineOrder();
    const aggregate = paidAggregate(order);
    const event = paidEvent(aggregate);
    database.seed(canonicalPaymentPath(order.id), {
      schemaVersion: 1,
      aggregate,
      attempts: {},
      operations: {},
      events: {[event.eventId]: event},
    });

    await expect(persistOnlineOrderDeliveryLedger(order, 1_500, database))
      .rejects.toThrow("LEDGER_ONLINE_PAYMENT_RECEIPT_MISSING");
  });

  it("rejects inconsistent order/payment identity and stale paid evidence", async () => {
    const wrongCustomerDatabase = new InMemoryOnlineLedgerDatabase();
    const order = deliveredOnlineOrder();
    const mismatched = paidAggregate(order, {customerId: "different-customer"});
    const mismatchEvent = paidEvent(mismatched);
    wrongCustomerDatabase.seed(canonicalPaymentPath(order.id), {
      schemaVersion: 1,
      aggregate: mismatched,
      attempts: {},
      operations: {},
      events: {[mismatchEvent.eventId]: mismatchEvent},
    });
    await expect(persistOnlineOrderDeliveryLedger(order, 1_500, wrongCustomerDatabase))
      .rejects.toThrow("LEDGER_ONLINE_PAYMENT_ORDER_MISMATCH");

    const staleEventDatabase = new InMemoryOnlineLedgerDatabase();
    const aggregate = paidAggregate(order);
    const staleEvent = paidEvent(aggregate, {revision: 0});
    staleEventDatabase.seed(canonicalPaymentPath(order.id), {
      schemaVersion: 1,
      aggregate,
      attempts: {},
      operations: {},
      events: {[staleEvent.eventId]: staleEvent},
    });
    await expect(persistOnlineOrderDeliveryLedger(order, 1_500, staleEventDatabase))
      .rejects.toThrow("LEDGER_ONLINE_PAYMENT_VERIFICATION_EVENT_INVALID");
  });

  it("rejects COD, undelivered, and publicly unpaid orders", async () => {
    const database = new InMemoryOnlineLedgerDatabase();
    await expect(persistOnlineOrderDeliveryLedger(
      deliveredOnlineOrder({paymentMethod: "cod"}), 1_500, database,
    )).rejects.toThrow("LEDGER_ORDER_NOT_DELIVERED_ONLINE");
    await expect(persistOnlineOrderDeliveryLedger(
      deliveredOnlineOrder({status: "Out for delivery"}), 1_500, database,
    )).rejects.toThrow("LEDGER_ORDER_NOT_DELIVERED_ONLINE");

    const unpaid = deliveredOnlineOrder({paymentState: "pending"});
    seedVerifiedPayment(database, unpaid);
    await expect(persistOnlineOrderDeliveryLedger(unpaid, 1_500, database))
      .rejects.toThrow("LEDGER_ONLINE_PAYMENT_NOT_VERIFIED_PAID");
  });
});
