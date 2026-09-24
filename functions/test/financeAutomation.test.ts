import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {
    collection: () => {
      throw new Error("TEST_DB_NOT_AVAILABLE");
    },
  },
}));

import {DEFAULT_FINANCE_POLICY, type FinancePolicy} from "../src/domain/financePolicy";
import {persistLedgerJournal, buildOnlineOrderDeliveryJournal} from "../src/services/ledger";
import {
  runWeeklyFinanceAutomation,
  type FinanceAutomationDatabase,
  type FinancePayoutGateway,
} from "../src/services/financeAutomation";
import {riderLedgerCoverageRef} from "../src/services/riderFinance";
import {riderRewardSettingsRef} from "../src/services/riderRewards";
import {restaurantLedgerCoverageRef} from "../src/services/restaurantSettlements";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

class MemoryDatabase extends InMemoryFirestore implements FinanceAutomationDatabase {}

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

function weeklyRunItemsPrefix(periodKey: string): string {
  return `private/financeAutomation/weeklyRuns/${periodKey}/items`;
}

function weeklyRunItems(database: MemoryDatabase, periodKey: string): Record<string, unknown> {
  const prefix = `${weeklyRunItemsPrefix(periodKey)}/`;
  const items: Record<string, unknown> = {};
  for (const path of database.paths()) {
    if (path.startsWith(prefix)) items[path.slice(prefix.length)] = database.read(path);
  }
  return items;
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
  database.seed(`riders/${riderId}`, {
    status: "approved",
    fullName: "Rider One",
    payoutProfile: payoutProfile ?? undefined,
  });
  database.seed(riderLedgerCoverageRef(database).path, {
    [riderId]: {
      schemaVersion: 1,
      riderId,
      historicalBackfillComplete: true,
      verifiedAt: 2_000,
    },
  });
}

function seedRestaurant(database: MemoryDatabase, restaurantId: string, payoutProfile: Record<string, unknown>): void {
  database.seed(`restaurants/${restaurantId}`, {
    name: "The Waffle Spot",
    payoutProfile,
  });
  database.seed(restaurantLedgerCoverageRef(database).path, {
    [restaurantId]: {
      schemaVersion: 1,
      restaurantId,
      historicalBackfillComplete: true,
      verifiedAt: 2_000,
    },
  });
}

describe("weekly finance automation", () => {
  let database: MemoryDatabase;
  let gateway: TestGateway;

  beforeEach(() => {
    database = new MemoryDatabase();
    gateway = new TestGateway();
    database.seed(riderRewardSettingsRef(database).path, {
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

    const items = weeklyRunItems(database, "2026-08-24");
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
    database.seed(riderRewardSettingsRef(database).path, {
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
