import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }}}));

import {
  LEDGER_JOURNALS_ROOT,
  buildCodEarningsOffsetJournal,
  buildCodOrderDeliveryJournal,
  buildCodRemittanceJournal,
  buildOnlineOrderDeliveryJournal,
  buildOnlinePaymentReceiptJournal,
  buildOnlinePaymentRefundJournal,
  ledgerJournalPath,
  orderDeliveryAmounts,
  persistLedgerJournal,
  type LedgerTransactionDatabase,
  type LedgerTransactionResult,
} from "../src/services/ledger";

const amounts = {
  grossAmountPaise: 14_000,
  restaurantPayablePaise: 9_000,
  platformCommissionPaise: 1_500,
  platformFeePaise: 200,
  taxPayablePaise: 300,
  riderDeliveryEarningPaise: 2_000,
  riderTipPaise: 1_000,
} as const;

const baseInput = {
  ...amounts,
  orderId: "SV-ORDER-DELIVERY-1",
  restaurantId: "restaurant-1",
  riderId: "rider-1",
  occurredAt: 1_700_000_000_000,
} as const;

class InMemoryTransactionDatabase implements LedgerTransactionDatabase {
  readonly paths: string[] = [];
  private readonly values = new Map<string, unknown>();

  ref(path: string) {
    this.paths.push(path);
    return {
      transaction: async (update: (current: unknown) => unknown): Promise<LedgerTransactionResult> => {
        const next = update(this.values.get(path) ?? null);
        if (next === undefined) {
          return {committed: false, snapshot: {val: () => this.values.get(path) ?? null}};
        }
        this.values.set(path, next);
        return {committed: true, snapshot: {val: () => this.values.get(path) ?? null}};
      },
    };
  }
}

function entryAmount(journal: ReturnType<typeof buildCodOrderDeliveryJournal>, accountId: string): number | undefined {
  return journal.entries.find((entry) => entry.accountId === accountId)?.amountPaise;
}

describe("backend ledger persistence", () => {
  it("derives a balanced allocation from the immutable server pricing snapshot", () => {
    const derived = orderDeliveryAmounts({
      total: 125,
      pricing: {
        subtotal: 100,
        discount: 10,
        deliveryFee: 20,
        smallOrderFee: 0,
        lateNightFee: 0,
        rainFee: 0,
        surgeFee: 0,
        platformFee: 5,
        tax: 5,
        tip: 5,
        currency: "INR",
        source: "catalog_snapshot_v3",
      },
    }, 1_500);
    expect(derived).toEqual({
      grossAmountPaise: 12_500,
      restaurantPayablePaise: 7_650,
      platformCommissionPaise: 1_350,
      platformFeePaise: 500,
      taxPayablePaise: 500,
      riderDeliveryEarningPaise: 2_000,
      riderTipPaise: 500,
    });
  });

  it("builds a balanced COD delivery allocation in integer paise", () => {
    const journal = buildCodOrderDeliveryJournal(baseInput);
    expect(journal.eventType).toBe("cod_delivery");
    expect(journal.currency).toBe("INR");
    expect(journal.debitTotalPaise).toBe(14_000);
    expect(journal.creditTotalPaise).toBe(14_000);
    expect(entryAmount(journal, "asset:cod-receivable:rider-1")).toBe(14_000);
    expect(entryAmount(journal, "liability:restaurant-payable:restaurant-1")).toBe(9_000);
    expect(entryAmount(journal, "revenue:platform-commission")).toBe(1_500);
    expect(entryAmount(journal, "revenue:platform-fees")).toBe(200);
    expect(entryAmount(journal, "liability:tax-payable")).toBe(300);
    expect(entryAmount(journal, "liability:rider-earnings:rider-1")).toBe(2_000);
    expect(entryAmount(journal, "liability:rider-tips:rider-1")).toBe(1_000);
  });

  it("releases verified online funds from the order holding account", () => {
    const journal = buildOnlineOrderDeliveryJournal({
      ...baseInput,
      paymentProvider: "phonepe",
      providerTransactionId: "phonepe-transaction-1",
    });
    expect(journal.eventType).toBe("payment");
    expect(journal.metadata).toMatchObject({
      paymentMethod: "online",
      paymentProvider: "phonepe",
      providerTransactionId: "phonepe-transaction-1",
    });
    expect(entryAmount(journal, "liability:customer-order-funds:SV-ORDER-DELIVERY-1")).toBe(14_000);
    expect(journal.debitTotalPaise).toBe(journal.creditTotalPaise);
  });

  it("records a verified gateway receipt in an order-scoped holding liability", () => {
    const journal = buildOnlinePaymentReceiptJournal({
      paymentId: "payment-1",
      orderId: baseInput.orderId,
      paymentProvider: "phonepe",
      providerTransactionId: "phonepe-payment-1",
      amountPaise: 14_000,
      occurredAt: baseInput.occurredAt,
    });
    expect(entryAmount(journal, "asset:payment-gateway-clearing:phonepe")).toBe(14_000);
    expect(entryAmount(journal, `liability:customer-order-funds:${baseInput.orderId}`)).toBe(14_000);
    expect(journal.metadata).toMatchObject({ledgerStage: "gateway_receipt"});
  });

  it("records verified refunds against held funds or explicit settlement recovery", () => {
    const beforeDelivery = buildOnlinePaymentRefundJournal({
      paymentId: "payment-1",
      orderId: baseInput.orderId,
      paymentProvider: "phonepe",
      providerTransactionId: "phonepe-refund-before-delivery",
      amountPaise: 14_000,
      occurredAt: baseInput.occurredAt,
      settlementReleased: false,
    });
    expect(entryAmount(beforeDelivery, `liability:customer-order-funds:${baseInput.orderId}`)).toBe(14_000);
    const afterDelivery = buildOnlinePaymentRefundJournal({
      paymentId: "payment-1",
      orderId: baseInput.orderId,
      paymentProvider: "phonepe",
      providerTransactionId: "phonepe-refund-after-delivery",
      amountPaise: 14_000,
      occurredAt: baseInput.occurredAt,
      settlementReleased: true,
    });
    expect(entryAmount(afterDelivery, `asset:refund-settlement-recovery:${baseInput.orderId}`)).toBe(14_000);
    expect(afterDelivery.metadata).toMatchObject({requiresSettlementRecovery: true});
  });

  it("records COD remittance as a separate immutable clearing event", () => {
    const journal = buildCodRemittanceJournal({
      remittanceId: "batch-2026-08-24-1",
      riderId: "rider-1",
      amountPaise: 9_500,
      occurredAt: 1_700_000_100_000,
      actorId: "admin-1",
      method: "upi",
      referenceId: "upi-reference-1",
    });
    expect(journal.eventType).toBe("cod_remittance");
    expect(journal.metadata).toMatchObject({
      riderId: "rider-1",
      remittanceMethod: "upi",
      referenceId: "upi-reference-1",
    });
    expect(entryAmount(journal, "asset:cod-settlement-clearing"))
      .toBe(9_500);
    expect(entryAmount(journal, "asset:cod-receivable:rider-1"))
      .toBe(9_500);
    expect(journal.debitTotalPaise).toBe(journal.creditTotalPaise);
  });

  it("keeps COD earnings offsets explicit instead of rewriting original earnings", () => {
    const journal = buildCodEarningsOffsetJournal({
      adjustmentId: "approved-offset-1",
      riderId: "rider-1",
      amountPaise: 2_000,
      occurredAt: 1_700_000_200_000,
      actorId: "admin-1",
      reason: "Approved weekly COD settlement",
    });
    expect(journal.eventType).toBe("adjustment");
    expect(journal.metadata).toMatchObject({
      riderId: "rider-1",
      adjustmentKind: "cod_against_rider_earnings",
    });
    expect(entryAmount(journal, "liability:rider-earnings:rider-1"))
      .toBe(2_000);
    expect(entryAmount(journal, "asset:cod-receivable:rider-1"))
      .toBe(2_000);
    expect(journal.debitTotalPaise).toBe(journal.creditTotalPaise);
  });

  it("rejects unsupported COD remittance methods and empty adjustment reasons", () => {
    expect(() => buildCodRemittanceJournal({
      remittanceId: "invalid-method",
      riderId: "rider-1",
      amountPaise: 100,
      occurredAt: 1_700_000_100_000,
      actorId: "admin-1",
      method: "card" as "upi",
    })).toThrow("LEDGER_INVALID_COD_REMITTANCE_METHOD");
    expect(() => buildCodEarningsOffsetJournal({
      adjustmentId: "empty-reason",
      riderId: "rider-1",
      amountPaise: 100,
      occurredAt: 1_700_000_100_000,
      actorId: "admin-1",
      reason: " ",
    })).toThrow("LEDGER_INVALID_COD_ADJUSTMENT_REASON");
  });

  it("rejects fractional and mismatched delivery allocations", () => {
    expect(() => buildCodOrderDeliveryJournal({...baseInput, riderTipPaise: 1.5}))
      .toThrow("LEDGER_INVALID_COMPONENT_AMOUNT_PAISE");
    expect(() => buildCodOrderDeliveryJournal({...baseInput, riderTipPaise: 999}))
      .toThrow("LEDGER_DELIVERY_ALLOCATION_MISMATCH");
  });

  it("persists at one deterministic private journal path", async () => {
    const database = new InMemoryTransactionDatabase();
    const journal = buildCodOrderDeliveryJournal(baseInput);
    const result = await persistLedgerJournal(journal, database);
    expect(result.outcome).toBe("insert");
    expect(result.path).toBe(`${LEDGER_JOURNALS_ROOT}/${journal.journalId}`);
    expect(result.path).toBe(ledgerJournalPath(journal));
    expect(database.paths).toEqual([result.path]);
    expect(database.paths.every((path) => !path.includes("riderWallets"))).toBe(true);
  });

  it("returns idempotent for an exact transaction retry", async () => {
    const database = new InMemoryTransactionDatabase();
    const first = buildCodOrderDeliveryJournal(baseInput);
    const retry = buildCodOrderDeliveryJournal(baseInput);
    await expect(persistLedgerJournal(first, database)).resolves.toMatchObject({outcome: "insert"});
    await expect(persistLedgerJournal(retry, database)).resolves.toMatchObject({
      outcome: "idempotent",
      path: ledgerJournalPath(first),
    });
  });

  it("rejects a changed payload at the same immutable journal path", async () => {
    const database = new InMemoryTransactionDatabase();
    const first = buildCodOrderDeliveryJournal(baseInput);
    const conflict = buildCodOrderDeliveryJournal({
      ...baseInput,
      restaurantPayablePaise: 8_900,
      platformCommissionPaise: 1_600,
    });
    expect(conflict.journalId).toBe(first.journalId);
    await persistLedgerJournal(first, database);
    await expect(persistLedgerJournal(conflict, database)).rejects.toThrow("LEDGER_IMMUTABLE_CONFLICT");
  });
});
