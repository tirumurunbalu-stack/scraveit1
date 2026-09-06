import type {DecodedIdToken} from "firebase-admin/auth";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }},
}));

import {createLedgerJournal, type LedgerJournal} from "../src/domain/ledger";
import {
  buildCodEarningsOffsetJournal,
  buildCodOrderDeliveryJournal,
  buildCodRemittanceJournal,
  buildOnlineOrderDeliveryJournal,
  buildOnlinePaymentRefundJournal,
  LEDGER_JOURNALS_ROOT,
} from "../src/services/ledger";
import {
  readRiderFinancialSummary,
  RIDER_LEDGER_COVERAGE_ROOT,
  RIDER_FINANCE_WALLET_ROOT,
  type RiderFinanceAuthorization,
  type RiderFinanceDatabase,
} from "../src/services/riderFinance";

const riderId = "rider-1";
const token = {} as DecodedIdToken;
const deliveryAmounts = {
  grossAmountPaise: 14_000,
  restaurantPayablePaise: 9_000,
  platformCommissionPaise: 1_500,
  platformFeePaise: 200,
  taxPayablePaise: 300,
  riderDeliveryEarningPaise: 2_000,
  riderTipPaise: 1_000,
} as const;

class MemoryRiderFinanceDatabase implements RiderFinanceDatabase {
  readonly values = new Map<string, unknown>();
  readonly queries: Array<[string, string, unknown]> = [];

  ref(path: string) {
    const chain = {
      orderByChild: (child: string) => {
        this.queries.push([path, "orderByChild", child]);
        return chain;
      },
      limitToLast: (limit: number) => {
        this.queries.push([path, "limitToLast", limit]);
        return chain;
      },
      get: async () => ({val: () => this.values.get(path) ?? null}),
    };
    return chain;
  }
}

function authorizer(overrides: Partial<RiderFinanceAuthorization> = {}): RiderFinanceAuthorization {
  return {
    requireRider: overrides.requireRider ?? (async () => ({})),
    requireAdmin: overrides.requireAdmin ?? (() => "ops_admin"),
  };
}

function journals(database: MemoryRiderFinanceDatabase, values: readonly LedgerJournal[]): void {
  database.values.set(LEDGER_JOURNALS_ROOT, Object.fromEntries(values.map((journal) => [journal.journalId, journal])));
}

function wallet(database: MemoryRiderFinanceDatabase, outstandingPaise: number, extras = {}): void {
  database.values.set(`${RIDER_FINANCE_WALLET_ROOT}/${riderId}`, {
    codOutstanding: outstandingPaise / 100,
    codOutstandingLimitPaise: 50_000,
    codRemittanceReservedPaise: 0,
    codBlocked: false,
    ...extras,
  });
  database.values.set(`${RIDER_LEDGER_COVERAGE_ROOT}/${riderId}`, {
    schemaVersion: 1,
    riderId,
    historicalBackfillComplete: true,
    verifiedAt: 1,
  });
}

function codDelivery(orderId = "order-cod-1", occurredAt = 100): LedgerJournal {
  return buildCodOrderDeliveryJournal({
    ...deliveryAmounts,
    orderId,
    restaurantId: "restaurant-1",
    riderId,
    occurredAt,
  });
}

async function read(
  database: MemoryRiderFinanceDatabase,
  input: {riderId?: string; ledgerLimit: number; historyLimit: number} = {ledgerLimit: 250, historyLimit: 50},
  authorization = authorizer(),
) {
  return readRiderFinancialSummary(riderId, token, input, database, authorization, () => 999);
}

describe("authoritative rider financial summary", () => {
  it("treats all COD cash as rider liability and only earnings/tips as income payable", async () => {
    const database = new MemoryRiderFinanceDatabase();
    const journal = codDelivery();
    journals(database, [journal]);
    wallet(database, 14_000);

    const result = await read(database);

    expect(result.complete).toBe(true);
    expect(result.payableEarningsPaise).toBe(3_000);
    expect(result.window).toMatchObject({
      completedDeliveryCount: 1,
      earningsCreditedPaise: 2_000,
      tipsCreditedPaise: 1_000,
      payableMovementPaise: 3_000,
      codCollectedPaise: 14_000,
      codMovementPaise: 14_000,
    });
    expect(result.cod).toMatchObject({
      outstandingPaise: 14_000,
      availableToRemitPaise: 14_000,
    });
    // The customer cash is deliberately not included in payable earnings.
    expect(result.payableEarningsPaise).not.toBe(17_000);
  });

  it("derives online delivery earnings without creating COD exposure", async () => {
    const database = new MemoryRiderFinanceDatabase();
    const journal = buildOnlineOrderDeliveryJournal({
      ...deliveryAmounts,
      orderId: "order-online-1",
      restaurantId: "restaurant-1",
      riderId,
      occurredAt: 101,
      paymentProvider: "phonepe",
      providerTransactionId: "gateway-1",
    });
    journals(database, [journal]);
    wallet(database, 0);

    const result = await read(database);
    expect(result.complete).toBe(true);
    expect(result.window).toMatchObject({
      completedDeliveryCount: 1,
      payableMovementPaise: 3_000,
      codCollectedPaise: 0,
      codMovementPaise: 0,
    });
  });

  it("separates COD remittance and explicit earnings offset without double counting", async () => {
    const database = new MemoryRiderFinanceDatabase();
    const delivery = codDelivery();
    const remittance = buildCodRemittanceJournal({
      remittanceId: "remit-1",
      riderId,
      amountPaise: 8_000,
      occurredAt: 110,
      actorId: "admin-1",
      method: "upi",
      referenceId: "upi-ref-1",
    });
    const offset = buildCodEarningsOffsetJournal({
      adjustmentId: "offset-1",
      riderId,
      amountPaise: 2_000,
      occurredAt: 120,
      actorId: "admin-1",
      reason: "Approved COD settlement against accrued delivery earnings",
    });
    journals(database, [delivery, remittance, offset]);
    wallet(database, 4_000);

    const result = await read(database);
    expect(result.complete).toBe(true);
    expect(result.payableEarningsPaise).toBe(1_000);
    expect(result.window).toMatchObject({
      earningsCreditedPaise: 2_000,
      tipsCreditedPaise: 1_000,
      earningsSettledOrAdjustedPaise: 2_000,
      codCollectedPaise: 14_000,
      codRemittedPaise: 8_000,
      codOffsetAgainstEarningsPaise: 2_000,
      codClearedPaise: 10_000,
      codMovementPaise: 4_000,
    });
  });

  it("reports already-cleared rider earnings and tips as settled-or-adjusted, not new income", async () => {
    const database = new MemoryRiderFinanceDatabase();
    const delivery = codDelivery();
    const settlement = createLedgerJournal({
      eventType: "adjustment",
      eventId: "rider-settlement:settlement-1",
      occurredAt: 130,
      actorId: "system:finance",
      metadata: {adjustmentKind: "rider_payable_settlement"},
      postings: [
        {accountId: `liability:rider-earnings:${riderId}`, side: "debit", amountPaise: 1_000},
        {accountId: `liability:rider-tips:${riderId}`, side: "debit", amountPaise: 500},
        {accountId: "asset:rider-settlement-clearing", side: "credit", amountPaise: 1_500},
      ],
    });
    journals(database, [delivery, settlement]);
    wallet(database, 14_000);

    const result = await read(database);
    expect(result.complete).toBe(true);
    expect(result.payableEarningsPaise).toBe(1_500);
    expect(result.window).toMatchObject({
      earningsSettledOrAdjustedPaise: 1_000,
      tipsSettledOrAdjustedPaise: 500,
    });
  });

  it("does not silently claw rider earnings or COD for a post-delivery refund recovery", async () => {
    const database = new MemoryRiderFinanceDatabase();
    const delivery = buildOnlineOrderDeliveryJournal({
      ...deliveryAmounts,
      orderId: "order-refunded-1",
      restaurantId: "restaurant-1",
      riderId,
      occurredAt: 100,
      paymentProvider: "phonepe",
      providerTransactionId: "gateway-payment-1",
    });
    const refund = buildOnlinePaymentRefundJournal({
      paymentId: "payment-1",
      orderId: "order-refunded-1",
      paymentProvider: "phonepe",
      providerTransactionId: "gateway-refund-1",
      amountPaise: 14_000,
      occurredAt: 140,
      settlementReleased: true,
    });
    journals(database, [delivery, refund]);
    wallet(database, 0);

    const result = await read(database);
    expect(result.complete).toBe(true);
    expect(result.payableEarningsPaise).toBe(3_000);
    expect(result.window.earningsSettledOrAdjustedPaise).toBe(0);
    expect(result.window.tipsSettledOrAdjustedPaise).toBe(0);
    expect(result.history).toHaveLength(1);
    expect(refund.entries.some((entry) => entry.accountId.startsWith("liability:rider-"))).toBe(false);
  });

  it("fails closed instead of presenting a bounded page as a lifetime payable", async () => {
    const database = new MemoryRiderFinanceDatabase();
    const first = codDelivery("order-1", 100);
    const second = codDelivery("order-2", 200);
    const third = codDelivery("order-3", 300);
    journals(database, [first, second, third]);
    wallet(database, 42_000);

    const result = await read(database, {ledgerLimit: 2, historyLimit: 2});
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reconciliationStatus).toBe("unverified_bounded_window");
    expect(result.payableEarningsPaise).toBeNull();
    expect(result.journalCount).toBe(2);
    expect(database.queries).toContainEqual([LEDGER_JOURNALS_ROOT, "limitToLast", 3]);
  });

  it("fails closed for a legacy rider without verified historical ledger coverage", async () => {
    const database = new MemoryRiderFinanceDatabase();
    journals(database, []);
    database.values.set(`${RIDER_FINANCE_WALLET_ROOT}/${riderId}`, {codOutstanding: 0});

    const result = await read(database);
    expect(result).toMatchObject({
      complete: false,
      coverageVerified: false,
      scope: "bounded_recent_journals",
      reconciliationStatus: "unknown_ledger_coverage",
      payableEarningsPaise: null,
    });
  });

  it("fails closed on wallet reconciliation mismatch or malformed wallet data", async () => {
    const mismatch = new MemoryRiderFinanceDatabase();
    journals(mismatch, [codDelivery()]);
    wallet(mismatch, 13_999);
    const result = await read(mismatch);
    expect(result.complete).toBe(false);
    expect(result.reconciliationStatus).toBe("wallet_mismatch");
    expect(result.payableEarningsPaise).toBeNull();

    const malformed = new MemoryRiderFinanceDatabase();
    journals(malformed, []);
    malformed.values.set(`${RIDER_FINANCE_WALLET_ROOT}/${riderId}`, {
      codOutstanding: 10,
      codRemittanceReservedPaise: 1_001,
    });
    await expect(read(malformed)).rejects.toMatchObject({
      code: "data-loss",
      details: {reason: "COD_RESERVATION_EXCEEDS_BALANCE"},
    });
  });

  it("marks tampered ledger rows incomplete and excludes them from all totals", async () => {
    const database = new MemoryRiderFinanceDatabase();
    const valid = codDelivery();
    database.values.set(LEDGER_JOURNALS_ROOT, {
      [valid.journalId]: valid,
      wrong_storage_key: {...valid, eventId: "tampered"},
    });
    wallet(database, 14_000);

    const result = await read(database);
    expect(result.complete).toBe(false);
    expect(result.reconciliationStatus).toBe("invalid_ledger_data");
    expect(result.invalidJournalCount).toBe(1);
    expect(result.window.codCollectedPaise).toBe(14_000);
    expect(result.payableEarningsPaise).toBeNull();
  });

  it("fails closed when two distinct delivery journals accrue rider income for one order", async () => {
    const database = new MemoryRiderFinanceDatabase();
    const first = codDelivery("order-duplicate", 100);
    const conflicting = buildOnlineOrderDeliveryJournal({
      ...deliveryAmounts,
      orderId: "order-duplicate",
      restaurantId: "restaurant-1",
      riderId,
      occurredAt: 101,
      paymentProvider: "phonepe",
      providerTransactionId: "unexpected-second-accrual",
    });
    journals(database, [first, conflicting]);
    wallet(database, 14_000);

    const result = await read(database);
    expect(result).toMatchObject({
      complete: false,
      reconciliationStatus: "duplicate_order_accrual",
      duplicateDeliveryAccrualCount: 1,
      payableEarningsPaise: null,
    });
    expect(result.window.completedDeliveryCount).toBe(1);
  });

  it("authorizes own-rider and cross-rider admin reads before any database access", async () => {
    const denied = new MemoryRiderFinanceDatabase();
    const denyRider = vi.fn(async () => { throw new Error("DENIED"); });
    await expect(read(denied, {ledgerLimit: 10, historyLimit: 10}, authorizer({requireRider: denyRider})))
      .rejects.toThrow("DENIED");
    expect(denied.queries).toEqual([]);

    const adminDb = new MemoryRiderFinanceDatabase();
    const requireAdmin = vi.fn(() => "ops_admin");
    adminDb.values.set(`${RIDER_FINANCE_WALLET_ROOT}/rider-2`, {codOutstanding: 0});
    adminDb.values.set(`${RIDER_LEDGER_COVERAGE_ROOT}/rider-2`, {
      schemaVersion: 1,
      riderId: "rider-2",
      historicalBackfillComplete: true,
      verifiedAt: 1,
    });
    const result = await readRiderFinancialSummary(
      riderId,
      token,
      {riderId: "rider-2", ledgerLimit: 10, historyLimit: 10},
      adminDb,
      authorizer({requireAdmin}),
      () => 999,
    );
    expect(requireAdmin).toHaveBeenCalledOnce();
    expect(result.riderId).toBe("rider-2");
  });

  it("is deterministic across retry/restart reads and bounds history independently", async () => {
    const database = new MemoryRiderFinanceDatabase();
    journals(database, [
      codDelivery("order-1", 100),
      buildCodRemittanceJournal({
        remittanceId: "remit-retry",
        riderId,
        amountPaise: 1_000,
        occurredAt: 200,
        actorId: "admin-1",
        method: "cash_deposit",
      }),
    ]);
    wallet(database, 13_000);

    const [first, concurrent] = await Promise.all([
      read(database, {ledgerLimit: 10, historyLimit: 1}),
      read(database, {ledgerLimit: 10, historyLimit: 1}),
    ]);
    const restarted = await read(database, {ledgerLimit: 10, historyLimit: 1});
    expect(first).toEqual(concurrent);
    expect(first).toEqual(restarted);
    expect(first.history).toHaveLength(1);
    expect(first.history[0].category).toBe("cod_remittance");
  });
});
