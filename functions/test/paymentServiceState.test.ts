import {createHash} from "node:crypto";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {orderRef} from "../src/firestorePaths";
import {LEDGER_JOURNALS_COLLECTION} from "../src/services/ledger";
import {
  applyVerifiedPayment,
  canonicalPaymentRef,
  initiatePayment,
  type CanonicalPaymentRecord,
  type PaymentDatabase,
  type PaymentGateway,
  type PaymentIntentRequest,
  type VerifiedPaymentEvent,
} from "../src/services/payments";
import type {SavrivoOrder} from "../src/types";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

class InMemoryPaymentDatabase extends InMemoryFirestore implements PaymentDatabase {}

function paymentAttemptByMerchantOrderPath(merchantOrderId: string): string {
  return `paymentAttemptsByMerchantOrder/${merchantOrderId}`;
}

function ledgerJournalPaths(database: InMemoryPaymentDatabase): string[] {
  return database.paths().filter((path) => path.startsWith(`${LEDGER_JOURNALS_COLLECTION}/`));
}

class DeterministicGateway implements PaymentGateway {
  readonly provider = "phonepe" as const;
  calls: PaymentIntentRequest[] = [];

  async createIntent(_order: SavrivoOrder, request: PaymentIntentRequest) {
    this.calls.push(request);
    return {
      provider: this.provider,
      merchantOrderId: request.merchantOrderId,
      redirectUrl: `https://payments.example.test/${request.merchantOrderId}`,
      expiresAt: 60_000,
    };
  }

  async verifyWebhook() {
    return {verified: false as const, reason: "TEST_GATEWAY_HAS_NO_HTTP_VERIFIER"};
  }
}

function order(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: "SV-PAYMENT-ORDER-1",
    schemaVersion: 3,
    idempotencyKey: "checkout-idempotency-1",
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
    paymentState: "pending",
    paymentPhase: "pending",
    terminalPhase: "none",
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
    status: "Order placed",
    statusHistory: {},
    createdAt: 1_000,
    updatedAt: 1_000,
    etaMin: 20,
    etaMax: 30,
    ...overrides,
  };
}

function verified(
  merchantOrderId: string,
  state: VerifiedPaymentEvent["state"],
  providerTransactionId: string,
  bodyIdentity: string,
  overrides: Partial<VerifiedPaymentEvent> = {},
): VerifiedPaymentEvent {
  return {
    verified: true,
    provider: "phonepe",
    merchantOrderId,
    providerTransactionId,
    amountPaise: 12_100,
    state,
    rawEventHash: createHash("sha256").update(bodyIdentity).digest("hex"),
    ...overrides,
  };
}

async function initiated() {
  const database = new InMemoryPaymentDatabase();
  const gateway = new DeterministicGateway();
  const sourceOrder = order();
  database.seed(orderRef(database, sourceOrder.id).path, sourceOrder);
  const intent = await initiatePayment(
    sourceOrder.customerId,
    {customerId: sourceOrder.customerId, orderId: sourceOrder.id},
    gateway,
    database,
    () => 2_000,
  );
  return {database, gateway, sourceOrder, intent};
}

describe("canonical payment service integration", () => {
  it("reuses one active provider intent instead of creating a duplicate", async () => {
    const {database, gateway, sourceOrder, intent} = await initiated();
    const retry = await initiatePayment(
      sourceOrder.customerId,
      {customerId: sourceOrder.customerId, orderId: sourceOrder.id},
      gateway,
      database,
      () => 3_000,
    );
    expect(retry).toEqual(intent);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({merchantOrderId: intent.merchantOrderId});
    expect(database.read(canonicalPaymentRef(database, sourceOrder.id).path) as CanonicalPaymentRecord | null)
      .toMatchObject({aggregate: {state: "pending", attemptSequence: 1, currentAttemptId: intent.merchantOrderId}});
  });

  it("applies a verified paid callback once and writes one immutable receipt journal", async () => {
    const {database, sourceOrder, intent} = await initiated();
    const event = verified(intent.merchantOrderId, "paid", "phonepe-payment-1", "paid-callback-1");
    await applyVerifiedPayment(event, database, () => 3_000);
    await applyVerifiedPayment(event, database, () => 4_000);

    const canonical = database.read(canonicalPaymentRef(database, sourceOrder.id).path) as CanonicalPaymentRecord | null;
    expect(canonical?.aggregate).toMatchObject({state: "paid", paidAmountPaise: 12_100});
    expect(Object.values(canonical?.operations ?? {}).filter((entry) => entry.afterState === "paid"))
      .toHaveLength(1);
    expect(ledgerJournalPaths(database)).toHaveLength(1);
    expect((database.read(orderRef(database, sourceOrder.id).path) as SavrivoOrder | null)?.paymentState).toBe("paid");
  });

  it("rejects a conflicting provider transaction for the same payment attempt", async () => {
    const {database, sourceOrder, intent} = await initiated();
    await applyVerifiedPayment(
      verified(intent.merchantOrderId, "paid", "phonepe-payment-stable", "paid-stable"),
      database,
      () => 3_000,
    );
    await expect(applyVerifiedPayment(
      verified(intent.merchantOrderId, "paid", "phonepe-payment-conflict", "paid-conflict"),
      database,
      () => 4_000,
    )).rejects.toThrow("different verified provider transaction");
    expect(ledgerJournalPaths(database)).toHaveLength(1);
    expect((database.read(canonicalPaymentRef(database, sourceOrder.id).path) as CanonicalPaymentRecord | null)?.aggregate.state).toBe("paid");
  });

  it("progresses a verified full refund and never duplicates receipt or refund journals", async () => {
    const {database, sourceOrder, intent} = await initiated();
    await applyVerifiedPayment(
      verified(intent.merchantOrderId, "paid", "phonepe-payment-2", "paid-callback-2"),
      database,
      () => 3_000,
    );
    const refund = verified(intent.merchantOrderId, "refunded", "phonepe-refund-2", "refund-callback-2");
    await applyVerifiedPayment(refund, database, () => 4_000);
    await applyVerifiedPayment(refund, database, () => 5_000);

    const canonical = database.read(canonicalPaymentRef(database, sourceOrder.id).path) as CanonicalPaymentRecord | null;
    expect(canonical?.aggregate).toMatchObject({
      state: "refunded",
      paidAmountPaise: 12_100,
      refundedAmountPaise: 12_100,
    });
    expect(ledgerJournalPaths(database)).toHaveLength(2);
    expect((database.read(orderRef(database, sourceOrder.id).path) as SavrivoOrder | null)?.paymentState).toBe("refunded");
  });

  it("rejects a second provider refund identity without duplicating financial entries", async () => {
    const {database, sourceOrder, intent} = await initiated();
    await applyVerifiedPayment(
      verified(intent.merchantOrderId, "paid", "phonepe-payment-refund-conflict", "paid-refund-conflict"),
      database,
      () => 3_000,
    );
    await applyVerifiedPayment(
      verified(intent.merchantOrderId, "refunded", "phonepe-refund-stable", "refund-stable"),
      database,
      () => 4_000,
    );
    await expect(applyVerifiedPayment(
      verified(intent.merchantOrderId, "refunded", "phonepe-refund-conflict", "refund-conflict"),
      database,
      () => 5_000,
    )).rejects.toThrow("different verified provider refund");
    expect(ledgerJournalPaths(database)).toHaveLength(2);
    expect((database.read(canonicalPaymentRef(database, sourceOrder.id).path) as CanonicalPaymentRecord | null)?.aggregate.state).toBe("refunded");
  });

  it("fails closed when a legacy paid order has no verified receipt provenance for refund", async () => {
    const database = new InMemoryPaymentDatabase();
    const sourceOrder = order({paymentState: "paid", paymentPhase: "paid"});
    const merchantOrderId = "SVPAY_LEGACY_WITHOUT_RECEIPT";
    database.seed(orderRef(database, sourceOrder.id).path, sourceOrder);
    database.seed(paymentAttemptByMerchantOrderPath(merchantOrderId), {
      customerId: sourceOrder.customerId,
      orderId: sourceOrder.id,
    });

    await expect(applyVerifiedPayment(
      verified(merchantOrderId, "refunded", "phonepe-refund-without-receipt", "legacy-refund"),
      database,
      () => 3_000,
    )).rejects.toThrow("requires verified receipt reconciliation");
    expect(database.read(canonicalPaymentRef(database, sourceOrder.id).path)).toBeNull();
    expect(ledgerJournalPaths(database)).toHaveLength(0);
  });

  it("rejects a verified amount mismatch before mutating canonical state or ledger", async () => {
    const {database, sourceOrder, intent} = await initiated();
    const event = verified(intent.merchantOrderId, "paid", "phonepe-payment-wrong", "wrong-amount", {
      amountPaise: 1,
    });
    await expect(applyVerifiedPayment(event, database, () => 3_000))
      .rejects.toThrow("Verified payment amount does not match the order");
    expect((database.read(canonicalPaymentRef(database, sourceOrder.id).path) as CanonicalPaymentRecord | null)?.aggregate.state).toBe("pending");
    expect(ledgerJournalPaths(database)).toHaveLength(0);
  });
});
