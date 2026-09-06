import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  db: {
    ref: () => {
      throw new Error("TEST_DB_NOT_AVAILABLE");
    },
  },
}));

import type {DecodedIdToken} from "firebase-admin/auth";
import {ROOT} from "../src/config";
import {
  DEFAULT_FINANCE_POLICY,
  type FinancePolicy,
} from "../src/domain/financePolicy";
import {DomainError} from "../src/errors";
import {persistLedgerJournal} from "../src/services/ledger";
import {
  recordRestaurantSettlement,
  recordRiderPayout,
  type FinancePayoutDatabase,
} from "../src/services/payouts";
import {getRestaurantSettlementSummary} from "../src/services/restaurantSettlements";
import {readRiderFinancialSummary} from "../src/services/riderFinance";
import {buildOnlineOrderDeliveryJournal} from "../src/services/ledger";

type QueryState = {
  orderByChild?: string;
  limitToLast?: number;
};

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
    private readonly query: QueryState = {},
  ) {}

  orderByChild(child: string): MemoryRef {
    return new MemoryRef(this.store, this.segments, {...this.query, orderByChild: child});
  }

  limitToLast(limit: number): MemoryRef {
    return new MemoryRef(this.store, this.segments, {...this.query, limitToLast: limit});
  }

  async get(): Promise<{val(): unknown}> {
    return new MemorySnapshot(applyQuery(readAt(this.store, this.segments), this.query));
  }

  async transaction(
    update: (current: unknown) => unknown,
  ): Promise<{committed: boolean; snapshot: {val(): unknown}}> {
    const current = readAt(this.store, this.segments);
    const next = update(structuredClone(current));
    if (next === undefined) {
      return {committed: false, snapshot: new MemorySnapshot(current)};
    }
    writeAt(this.store, this.segments, next);
    return {committed: true, snapshot: new MemorySnapshot(next)};
  }
}

class MemoryDatabase implements FinancePayoutDatabase {
  readonly data: Record<string, unknown>;

  constructor(seed?: Record<string, unknown>) {
    this.data = structuredClone(seed ?? {}) as Record<string, unknown>;
  }

  ref(path: string): MemoryRef {
    return new MemoryRef(this.data, pathSegments(path));
  }

  seed(path: string, value: unknown): void {
    writeAt(this.data, pathSegments(path), value);
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

function compareScalar(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function applyQuery(value: unknown, query: QueryState): unknown {
  if (!query.orderByChild || !value || typeof value !== "object" || Array.isArray(value)) {
    return structuredClone(value);
  }
  let entries = Object.entries(value as Record<string, Record<string, unknown>>)
    .sort((left, right) => {
      const leftValue = left[1]?.[query.orderByChild as string];
      const rightValue = right[1]?.[query.orderByChild as string];
      return compareScalar(leftValue, rightValue) || left[0].localeCompare(right[0]);
    });
  if (query.limitToLast !== undefined) entries = entries.slice(Math.max(0, entries.length - query.limitToLast));
  return Object.fromEntries(entries);
}

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
    database.seed(`${ROOT}/riders/rider-1`, {
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
    database.seed(`${ROOT}/riderWallets/rider-1`, {
      codOutstanding: 0,
      codOutstandingLimitPaise: 500_000,
      codRemittanceReservedPaise: 0,
      codBlocked: false,
    });
    database.seed(`${ROOT}/private/financialLedger/coverage/riders/rider-1`, {
      schemaVersion: 1,
      riderId: "rider-1",
      historicalBackfillComplete: true,
      verifiedAt: 2_000,
    });
    database.seed(`${ROOT}/catalog/restaurants/restaurant-1`, {
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
    database.seed(`${ROOT}/private/financialLedger/coverage/restaurants/restaurant-1`, {
      schemaVersion: 1,
      restaurantId: "restaurant-1",
      historicalBackfillComplete: true,
      verifiedAt: 2_000,
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
