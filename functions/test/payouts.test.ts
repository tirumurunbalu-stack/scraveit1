import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {
    collection: () => {
      throw new Error("TEST_DB_NOT_AVAILABLE");
    },
  },
}));

import type {DecodedIdToken} from "firebase-admin/auth";
import {
  DEFAULT_FINANCE_POLICY,
  type FinancePolicy,
} from "../src/domain/financePolicy";
import {DomainError} from "../src/errors";
import {buildOnlineOrderDeliveryJournal, persistLedgerJournal} from "../src/services/ledger";
import {
  recordRestaurantSettlement,
  recordRiderPayout,
  type FinancePayoutDatabase,
} from "../src/services/payouts";
import {getRestaurantSettlementSummary, restaurantLedgerCoverageRef} from "../src/services/restaurantSettlements";
import {readRiderFinancialSummary, riderLedgerCoverageRef, riderWalletRef} from "../src/services/riderFinance";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

class MemoryDatabase extends InMemoryFirestore implements FinancePayoutDatabase {}

function adminToken(): DecodedIdToken {
  return {
    uid: "owner-1",
    email: "owner@scraveit.test",
    savrivoRole: "owner",
  } as unknown as DecodedIdToken;
}

function financePolicy(overrides?: Partial<FinancePolicy["payouts"]>): FinancePolicy {
  const base = structuredClone(DEFAULT_FINANCE_POLICY) as FinancePolicy;
  if (overrides) base.payouts = {...base.payouts, ...overrides};
  return base;
}

async function seedDeliveryLedger(database: MemoryDatabase): Promise<void> {
  await persistLedgerJournal(buildOnlineOrderDeliveryJournal({
    orderId: "order-1",
    restaurantId: "restaurant-1",
    riderId: "rider-1",
    occurredAt: 1_000,
    paymentProvider: "phonepe",
    providerTransactionId: "txn-1",
    grossAmountPaise: 17_000,
    restaurantPayablePaise: 10_000,
    platformCommissionPaise: 2_000,
    platformFeePaise: 2_000,
    taxPayablePaise: 500,
    riderDeliveryEarningPaise: 2_000,
    riderTipPaise: 500,
  }), database);
}

describe("money disbursement services", () => {
  let database: MemoryDatabase;

  beforeEach(async () => {
    database = new MemoryDatabase();
    database.seed("riders/rider-1", {
      status: "approved",
      fullName: "Rider One",
      payoutProfile: {
        beneficiaryName: "Rider One",
        preferredMethod: "upi",
        upiId: "riderone@okhdfcbank",
        bankAccountHolderName: "Rider One",
        bankAccountNumber: "123456789012",
        bankIfsc: "HDFC0001234",
      },
    });
    database.seed(riderWalletRef(database, "rider-1").path, {
      codOutstanding: 0,
      codOutstandingLimitPaise: 500_000,
      codRemittanceReservedPaise: 0,
      codBlocked: false,
    });
    database.seed(riderLedgerCoverageRef(database).path, {
      "rider-1": {
        schemaVersion: 1,
        riderId: "rider-1",
        historicalBackfillComplete: true,
        verifiedAt: 2_000,
      },
    });
    database.seed("restaurants/restaurant-1", {
      name: "The Waffle Spot",
      payoutProfile: {
        legalBusinessName: "The Waffle Spot LLP",
        beneficiaryName: "The Waffle Spot",
        preferredMethod: "neft",
        upiId: "waffle@okaxis",
        bankAccountHolderName: "The Waffle Spot LLP",
        bankAccountNumber: "987654321012",
        bankIfsc: "HDFC0009876",
      },
    });
    database.seed(restaurantLedgerCoverageRef(database).path, {
      "restaurant-1": {
        schemaVersion: 1,
        restaurantId: "restaurant-1",
        historicalBackfillComplete: true,
        verifiedAt: 2_000,
      },
    });
    await seedDeliveryLedger(database);
  });

  it("records a rider payout once and keeps exact retries idempotent", async () => {
    const policy = financePolicy();

    const first = await recordRiderPayout(
      "owner-1",
      adminToken(),
      {
        operationId: "rider-payout-op-123456",
        riderId: "rider-1",
        amountPaise: 2_000,
        method: "upi",
        referenceId: "UPI-REF-1",
      },
      database,
      5_000,
      async () => policy,
    );

    expect(first.idempotent).toBe(false);
    expect(first.paidEarningsPaise).toBe(2_000);
    expect(first.paidTipsPaise).toBe(0);
    expect(first.remainingPayablePaise).toBe(500);

    const second = await recordRiderPayout(
      "owner-1",
      adminToken(),
      {
        operationId: "rider-payout-op-123456",
        riderId: "rider-1",
        amountPaise: 2_000,
        method: "upi",
        referenceId: "UPI-REF-1",
      },
      database,
      6_000,
      async () => policy,
    );

    expect(second.idempotent).toBe(true);
    expect(second.ledgerJournalId).toBe(first.ledgerJournalId);

    const summary = await readRiderFinancialSummary(
      "owner-1",
      adminToken(),
      {riderId: "rider-1", ledgerLimit: 250, historyLimit: 50},
      database,
    );

    expect(summary.payableEarningsPaise).toBe(500);
    expect(summary.history.some((row) => row.eventType === "rider_payout")).toBe(true);
  });

  it("rejects a reused rider payout operation id with a different payload", async () => {
    const policy = financePolicy();
    await recordRiderPayout(
      "owner-1",
      adminToken(),
      {
        operationId: "rider-payout-op-abcdef",
        riderId: "rider-1",
        amountPaise: 1_000,
        method: "upi",
        referenceId: "UPI-REF-2",
      },
      database,
      5_000,
      async () => policy,
    );

    await expect(recordRiderPayout(
      "owner-1",
      adminToken(),
      {
        operationId: "rider-payout-op-abcdef",
        riderId: "rider-1",
        amountPaise: 1_500,
        method: "upi",
        referenceId: "UPI-REF-2",
      },
      database,
      6_000,
      async () => policy,
    )).rejects.toMatchObject({code: "already-exists"});
  });

  it("blocks high-value rider UPI payouts above the configured threshold", async () => {
    const policy = financePolicy({upiPreferredMaximumPaise: 1_500});
    await expect(recordRiderPayout(
      "owner-1",
      adminToken(),
      {
        operationId: "rider-payout-op-threshold",
        riderId: "rider-1",
        amountPaise: 2_000,
        method: "upi",
        referenceId: "UPI-REF-3",
      },
      database,
      5_000,
      async () => policy,
    )).rejects.toMatchObject<Partial<DomainError>>({
      code: "failed-precondition",
    });
  });

  it("records a restaurant settlement once and keeps exact retries idempotent", async () => {
    const policy = financePolicy();

    const first = await recordRestaurantSettlement(
      "owner-1",
      adminToken(),
      {
        operationId: "restaurant-settlement-op-1234",
        restaurantId: "restaurant-1",
        amountPaise: 6_000,
        method: "neft",
        referenceId: "NEFT-REF-1",
      },
      database,
      7_000,
      async () => policy,
    );

    expect(first.idempotent).toBe(false);
    expect(first.remainingPendingSettlementPaise).toBe(4_000);

    const second = await recordRestaurantSettlement(
      "owner-1",
      adminToken(),
      {
        operationId: "restaurant-settlement-op-1234",
        restaurantId: "restaurant-1",
        amountPaise: 6_000,
        method: "neft",
        referenceId: "NEFT-REF-1",
      },
      database,
      8_000,
      async () => policy,
    );

    expect(second.idempotent).toBe(true);
    expect(second.ledgerJournalId).toBe(first.ledgerJournalId);

    const summary = await getRestaurantSettlementSummary(
      "owner-1",
      adminToken(),
      {restaurantId: "restaurant-1", ledgerLimit: 1_000, historyLimit: 50},
      database,
    );

    expect(summary.pendingSettlementPaise).toBe(4_000);
    expect(summary.alreadySettledPaise).toBe(6_000);
  });

  it("rejects a restaurant settlement above the authoritative pending balance", async () => {
    const policy = financePolicy();
    await expect(recordRestaurantSettlement(
      "owner-1",
      adminToken(),
      {
        operationId: "restaurant-settlement-op-excess",
        restaurantId: "restaurant-1",
        amountPaise: 12_000,
        method: "neft",
        referenceId: "NEFT-REF-2",
      },
      database,
      7_000,
      async () => policy,
    )).rejects.toMatchObject({code: "failed-precondition"});
  });
});
