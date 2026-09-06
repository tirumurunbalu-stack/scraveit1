import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  db: {
    ref: () => {
      throw new Error("TEST_DB_NOT_AVAILABLE");
    },
  },
}));

import {ROOT} from "../src/config";
import {DEFAULT_FINANCE_POLICY, type FinancePolicy} from "../src/domain/financePolicy";
import {persistLedgerJournal, buildOnlineOrderDeliveryJournal} from "../src/services/ledger";
import {
  FINANCE_AUTOMATION_WEEKLY_RUNS_ROOT,
  RESTAURANT_LEDGER_COVERAGE_ROOT,
  RIDER_LEDGER_COVERAGE_ROOT,
  runWeeklyFinanceAutomation,
  type FinanceAutomationDatabase,
  type FinancePayoutGateway,
} from "../src/services/financeAutomation";
import {RIDER_REWARD_SETTINGS_ROOT} from "../src/services/riderRewards";

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

class MemoryDatabase implements FinanceAutomationDatabase {
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

class TestGateway implements FinancePayoutGateway {
  readonly configured = true;
  readonly calls: Array<{
    entityType: "rider" | "restaurant";
    entityId: string;
    amountPaise: number;
    method: "upi" | "imps" | "neft";
    operationId: string;
  }> = [];
  private readonly responses = new Map<string, {providerOperationId: string; referenceId: string}>();

  async executePayout(request: {
    entityType: "rider" | "restaurant";
    entityId: string;
    amountPaise: number;
    method: "upi" | "imps" | "neft";
    operationId: string;
  }): Promise<{
    provider: string;
    providerOperationId: string;
    referenceId: string;
    completedAt: number;
  }> {
    this.calls.push(request);
    const existing = this.responses.get(request.operationId);
    if (existing) {
      return {
        provider: "test_gateway",
        providerOperationId: existing.providerOperationId,
        referenceId: existing.referenceId,
        completedAt: 1_000_000,
      };
    }
    const response = {
      providerOperationId: `provider-${request.operationId}`,
      referenceId: `REF-${this.calls.length}`,
    };
    this.responses.set(request.operationId, response);
    return {
      provider: "test_gateway",
      providerOperationId: response.providerOperationId,
      referenceId: response.referenceId,
      completedAt: 1_000_000,
    };
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

function weeklyPolicy(overrides?: Partial<FinancePolicy["payouts"]>): FinancePolicy {
  const base = structuredClone(DEFAULT_FINANCE_POLICY) as FinancePolicy;
  const automation = {
    ...base.payouts.automation,
    enabled: true,
    cadence: "weekly" as const,
    timezone: "Asia/Kolkata",
    executionDayOfWeek: 1,
    executionMinuteOfDay: 10 * 60 + 30,
    ridersEnabled: true,
    restaurantsEnabled: true,
    ...(overrides?.automation ?? {}),
  };
  base.payouts = {
    ...base.payouts,
    ...overrides,
    automation,
  };
  return base;
}

async function seedDeliveryLedger(database: MemoryDatabase, input?: Partial<{
  orderId: string;
  restaurantId: string;
  riderId: string;
  occurredAt: number;
  grossAmountPaise: number;
  restaurantPayablePaise: number;
  platformCommissionPaise: number;
  platformFeePaise: number;
  taxPayablePaise: number;
  riderDeliveryEarningPaise: number;
  riderTipPaise: number;
}>): Promise<void> {
  await persistLedgerJournal(buildOnlineOrderDeliveryJournal({
    orderId: input?.orderId ?? "order-1",
    restaurantId: input?.restaurantId ?? "restaurant-1",
    riderId: input?.riderId ?? "rider-1",
    occurredAt: input?.occurredAt ?? 1_000,
    paymentProvider: "phonepe",
    providerTransactionId: `txn-${input?.orderId ?? "1"}`,
    grossAmountPaise: input?.grossAmountPaise ?? 17_000,
    restaurantPayablePaise: input?.restaurantPayablePaise ?? 10_000,
    platformCommissionPaise: input?.platformCommissionPaise ?? 2_000,
    platformFeePaise: input?.platformFeePaise ?? 2_000,
    taxPayablePaise: input?.taxPayablePaise ?? 500,
    riderDeliveryEarningPaise: input?.riderDeliveryEarningPaise ?? 2_000,
    riderTipPaise: input?.riderTipPaise ?? 500,
  }), database);
}

function seedRider(database: MemoryDatabase, riderId: string, payoutProfile: Record<string, unknown> | null): void {
  database.seed(`${ROOT}/riders/${riderId}`, {
    status: "approved",
    fullName: "Rider One",
    payoutProfile: payoutProfile ?? undefined,
  });
  database.seed(`${RIDER_LEDGER_COVERAGE_ROOT}/${riderId}`, {
    schemaVersion: 1,
    riderId,
    historicalBackfillComplete: true,
    verifiedAt: 2_000,
  });
}

function seedRestaurant(database: MemoryDatabase, restaurantId: string, payoutProfile: Record<string, unknown>): void {
  database.seed(`${ROOT}/catalog/restaurants/${restaurantId}`, {
    name: "The Waffle Spot",
    payoutProfile,
  });
  database.seed(`${RESTAURANT_LEDGER_COVERAGE_ROOT}/${restaurantId}`, {
    schemaVersion: 1,
    restaurantId,
    historicalBackfillComplete: true,
    verifiedAt: 2_000,
  });
}

describe("weekly finance automation", () => {
  let database: MemoryDatabase;
  let gateway: TestGateway;

  beforeEach(() => {
    database = new MemoryDatabase();
    gateway = new TestGateway();
    database.seed(RIDER_REWARD_SETTINGS_ROOT, {
      schemaVersion: 1,
      payoutMinimumPaise: 0,
      referralProgramActive: false,
      inviterRewardPaise: 0,
      inviteeRewardPaise: 0,
      referralMinCompletedTrips: 0,
      referralMaxRewardsPerRider: 0,
      updatedAt: 0,
      updatedBy: "",
      updatedByRole: "",
      lastOperationId: "",
    });
  });

  it("returns a disabled summary when weekly automation is off", async () => {
    const summary = await runWeeklyFinanceAutomation(
      Date.parse("2026-08-25T06:00:00.000Z"),
      database,
      gateway,
      async () => structuredClone(DEFAULT_FINANCE_POLICY) as FinancePolicy,
    );
    expect(summary.status).toBe("disabled");
    expect(summary.periodKey).toBeNull();
    expect(gateway.calls).toHaveLength(0);
  });

  it("settles rider payouts and restaurant settlements once per weekly period", async () => {
    seedRider(database, "rider-1", {
      beneficiaryName: "Rider One",
      preferredMethod: "upi",
      upiId: "riderone@okhdfcbank",
      bankAccountHolderName: "Rider One",
      bankAccountNumber: "123456789012",
      bankIfsc: "HDFC0001234",
    });
    seedRestaurant(database, "restaurant-1", {
      legalBusinessName: "The Waffle Spot LLP",
      beneficiaryName: "The Waffle Spot",
      preferredMethod: "neft",
      upiId: "waffle@okaxis",
      bankAccountHolderName: "The Waffle Spot LLP",
      bankAccountNumber: "987654321012",
      bankIfsc: "HDFC0009876",
    });
    await seedDeliveryLedger(database);

    const first = await runWeeklyFinanceAutomation(
      Date.parse("2026-08-25T06:00:00.000Z"),
      database,
      gateway,
      async () => weeklyPolicy(),
    );

    expect(first).toMatchObject({
      periodKey: "2026-08-24",
      status: "completed",
      counts: {completed: 2},
    });
    expect(first.journalIds).toHaveLength(2);
    expect(gateway.calls).toHaveLength(2);

    const second = await runWeeklyFinanceAutomation(
      Date.parse("2026-08-26T06:00:00.000Z"),
      database,
      gateway,
      async () => weeklyPolicy(),
    );

    expect(second).toEqual(first);
    expect(gateway.calls).toHaveLength(2);

    const items = readAt(database.data, pathSegments(`${FINANCE_AUTOMATION_WEEKLY_RUNS_ROOT}/2026-08-24/items`)) as Record<string, unknown>;
    expect(Object.values(items).every((item) => (item as {status?: string}).status === "completed")).toBe(true);
  });

  it("holds payouts below the configured rider minimum", async () => {
    seedRider(database, "rider-1", {
      beneficiaryName: "Rider One",
      preferredMethod: "upi",
      upiId: "riderone@okhdfcbank",
    });
    await seedDeliveryLedger(database, {
      restaurantPayablePaise: 0,
      platformCommissionPaise: 14_500,
      platformFeePaise: 0,
      taxPayablePaise: 0,
      riderDeliveryEarningPaise: 2_000,
      riderTipPaise: 500,
      grossAmountPaise: 17_000,
    });
    database.seed(RIDER_REWARD_SETTINGS_ROOT, {
      schemaVersion: 1,
      payoutMinimumPaise: 5_000,
      referralProgramActive: false,
      inviterRewardPaise: 0,
      inviteeRewardPaise: 0,
      referralMinCompletedTrips: 0,
      referralMaxRewardsPerRider: 0,
      updatedAt: 0,
      updatedBy: "",
      updatedByRole: "",
      lastOperationId: "",
    });

    const summary = await runWeeklyFinanceAutomation(
      Date.parse("2026-08-25T06:00:00.000Z"),
      database,
      gateway,
      async () => weeklyPolicy({automation: {...weeklyPolicy().payouts.automation, restaurantsEnabled: false}}),
    );

    expect(summary.status).toBe("completed");
    expect(summary.counts.heldMinimum).toBe(1);
    expect(summary.journalIds).toEqual([]);
    expect(gateway.calls).toHaveLength(0);
  });

  it("blocks automation when the rider payout profile is incomplete", async () => {
    seedRider(database, "rider-1", null);
    await seedDeliveryLedger(database, {
      restaurantPayablePaise: 0,
      platformCommissionPaise: 14_500,
      platformFeePaise: 0,
      taxPayablePaise: 0,
      riderDeliveryEarningPaise: 2_000,
      riderTipPaise: 500,
      grossAmountPaise: 17_000,
    });

    const summary = await runWeeklyFinanceAutomation(
      Date.parse("2026-08-25T06:00:00.000Z"),
      database,
      gateway,
      async () => weeklyPolicy({automation: {...weeklyPolicy().payouts.automation, restaurantsEnabled: false}}),
    );

    expect(summary.status).toBe("completed_with_blocks");
    expect(summary.counts.blockedProfile).toBe(1);
    expect(summary.journalIds).toEqual([]);
    expect(gateway.calls).toHaveLength(0);
  });

  it("routes higher-value weekly settlements to the configured bank rail", async () => {
    seedRestaurant(database, "restaurant-1", {
      legalBusinessName: "The Waffle Spot LLP",
      beneficiaryName: "The Waffle Spot",
      preferredMethod: "upi",
      upiId: "waffle@okaxis",
      bankAccountHolderName: "The Waffle Spot LLP",
      bankAccountNumber: "987654321012",
      bankIfsc: "HDFC0009876",
    });
    await seedDeliveryLedger(database, {
      grossAmountPaise: 200_000,
      restaurantPayablePaise: 150_000,
      platformCommissionPaise: 20_000,
      platformFeePaise: 30_000,
      taxPayablePaise: 0,
      riderDeliveryEarningPaise: 0,
      riderTipPaise: 0,
    });

    const summary = await runWeeklyFinanceAutomation(
      Date.parse("2026-08-25T06:00:00.000Z"),
      database,
      gateway,
      async () => weeklyPolicy({
        upiPreferredMaximumPaise: 100_000,
        highValuePayoutMethod: "neft",
        automation: {
          ...weeklyPolicy().payouts.automation,
          ridersEnabled: false,
          restaurantsEnabled: true,
        },
      }),
    );

    expect(summary.counts.completed).toBe(1);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({
      entityType: "restaurant",
      method: "neft",
      amountPaise: 150_000,
    });
  });
});
