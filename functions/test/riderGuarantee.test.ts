import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("TEST_DB_NOT_AVAILABLE"); }},
  messaging: {sendEachForMulticast: vi.fn(async () => ({successCount: 0, failureCount: 0, responses: []}))},
  storage: {},
}));

vi.mock("../src/services/notifications", () => ({
  notifyRiderRewardUpdate: vi.fn(async () => undefined),
}));

import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
import {buildCodOrderDeliveryJournal, LEDGER_JOURNALS_COLLECTION, persistLedgerJournal} from "../src/services/ledger";
import {clearEconomicsControlCache} from "../src/services/economics";
import {
  refreshRiderRewardProgress,
  settleQualifiedRiderRewardPeriods,
  type RiderRewardActivityEvent,
  type RiderRewardCampaign,
} from "../src/services/riderRewards";
import type {LedgerJournal} from "../src/domain/ledger";

function at(localDateTime: string): number {
  return Date.parse(`${localDateTime}+05:30`);
}

const DINNER_START = 19 * 60;
const DINNER_END = 23 * 60;

/** "Dinner Earnings Guarantee": 3 deliveries -> Rs 300, 5 deliveries -> Rs 600, 7pm-11pm, at most 1 reject. */
function guaranteeCampaign(overrides: Partial<RiderRewardCampaign> = {}): RiderRewardCampaign {
  return {
    schemaVersion: 1,
    campaignId: "dinner-guarantee",
    internalName: "Dinner guarantee",
    title: "Dinner Earnings Guarantee",
    subtitle: "",
    description: "",
    kind: "milestone_bonus",
    displayType: "shift_bonus",
    section: "dinner",
    rewardAmountPaise: null,
    milestones: [
      {target: 3, rewardAmountPaise: 30_000, label: "3 deliveries"},
      {target: 5, rewardAmountPaise: 60_000, label: "5 deliveries"},
    ],
    window: "custom",
    startAt: at("2026-08-26T00:00:00"),
    endAt: at("2026-08-27T00:00:00"),
    eligibleDays: [],
    timeSlots: [{label: "Dinner", startMinute: DINNER_START, endMinute: DINNER_END}],
    cityNames: [],
    zoneNames: [],
    restaurantIds: [],
    riderIds: [],
    minCompletedTrips: null,
    minRating: null,
    firstNCompletedTrips: null,
    orderTotalMinPaise: null,
    rainOnly: false,
    requireDailyLoginSession: false,
    minimumCompletedSessionsPerDay: null,
    conditionGroups: [],
    otherConditions: [{
      conditionId: "rejects", type: "max_rejected_orders", title: "Rejects", maximumCount: 1,
      minimumCount: null, minimumPercentage: null, maximumMinutes: null, minimumMinutes: null,
      minimumRating: null, enabled: true,
    }],
    milestonePayoutMode: "earnings_guarantee",
    guaranteeComponents: ["trip_pay", "per_order_incentives"],
    budgetPaise: 0,
    maxEligibleRiders: 0,
    timezone: "Asia/Kolkata",
    tripAttribution: "delivered_at",
    allowOverlappingSlotCredit: false,
    eligibleRiderTypes: [],
    vehicleTypes: [],
    minimumAccountAgeDays: null,
    stacking: "stack",
    priority: 100,
    visible: true,
    active: true,
    archived: false,
    updatedAt: at("2026-08-20T12:00:00"),
    updatedBy: "admin_test",
    updatedByRole: "owner",
    lastOperationId: "seed_campaign",
    ...overrides,
  };
}

let db: InMemoryFirestore;

function activity(riderId: string, eventId: string, type: RiderRewardActivityEvent["type"], occurredAt: number, orderId = ""): RiderRewardActivityEvent {
  return {schemaVersion: 1, riderId, eventId, type, occurredAt, orderId, metadata: {}};
}

function seedEvent(event: RiderRewardActivityEvent): void {
  db.seed(`private/riderRewards/activityEvents/${event.riderId}/events/${event.eventId}`, event);
}

async function deliver(riderId: string, orderId: string, occurredAt: number, tripPaise: number, tipPaise = 0): Promise<void> {
  seedEvent(activity(riderId, `${orderId}:delivered`, "ORDER_DELIVERED", occurredAt, orderId));
  const gross = 30_000 + tripPaise + tipPaise;
  await persistLedgerJournal(buildCodOrderDeliveryJournal({
    orderId, restaurantId: "r1", riderId, occurredAt,
    grossAmountPaise: gross,
    restaurantPayablePaise: 27_000,
    platformCommissionPaise: 3_000,
    platformFeePaise: 0,
    taxPayablePaise: 0,
    riderDeliveryEarningPaise: tripPaise,
    riderTipPaise: tipPaise,
  }), db);
}

function goOnline(riderId: string): void {
  seedEvent(activity(riderId, `${riderId}:online`, "ONLINE", at("2026-08-26T18:55:00")));
  for (let t = at("2026-08-26T19:00:00"); t < at("2026-08-26T23:00:00"); t += 5 * 60_000) {
    seedEvent(activity(riderId, `${riderId}:hb:${t}`, "HEARTBEAT", t));
  }
  seedEvent(activity(riderId, `${riderId}:offline`, "OFFLINE", at("2026-08-26T23:05:00")));
}

async function workDinner(riderId: string, trips: number, tripPaise: number, tipPaise = 0): Promise<void> {
  goOnline(riderId);
  for (let index = 0; index < trips; index += 1) {
    await deliver(riderId, `${riderId}_o${index}`, at("2026-08-26T19:30:00") + index * 20 * 60_000, tripPaise, tipPaise);
  }
}

function guaranteeJournals(): LedgerJournal[] {
  return db.paths()
    .filter((path) => path.startsWith(`${LEDGER_JOURNALS_COLLECTION}/`))
    .map((path) => db.read(path) as LedgerJournal)
    .filter((journal) => journal.metadata.payoutMode === "earnings_guarantee");
}

const AFTER_PERIOD = at("2026-08-27T00:10:00");

beforeEach(() => {
  db = new InMemoryFirestore();
  clearEconomicsControlCache();
  db.seed("riders/rider_1", {name: "Rider One", city: "Nellore", approvedAt: at("2026-01-01T00:00:00")});
  db.seed("riders/rider_2", {name: "Rider Two", city: "Nellore", approvedAt: at("2026-01-01T00:00:00")});
});

describe("minimum earnings guarantee campaigns", () => {
  it("pays only the shortfall: Rs 300 earned against a Rs 600 guarantee costs Rs 300", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign());
    await workDinner("rider_1", 5, 6_000);
    // A lunch delivery outside the dinner slot does not count toward the dinner guarantee.
    await deliver("rider_1", "lunch_1", at("2026-08-26T12:30:00"), 9_000);

    const during = await refreshRiderRewardProgress("rider_1", at("2026-08-26T22:50:00"), db);
    expect(during[0]?.guarantee).toMatchObject({
      completedDeliveries: 5, tierTarget: 5, guaranteedPaise: 60_000, eligibleEarningsPaise: 30_000, topUpPaise: 30_000,
    });
    expect(guaranteeJournals()).toHaveLength(0);

    const after = await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    const journals = guaranteeJournals();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.entries.find((entry) => entry.accountId === "expense:rider-guarantee-topups")?.amountPaise).toBe(30_000);
    expect(journals[0]?.metadata).toMatchObject({eligibleEarningsPaise: 30_000, guaranteedPaise: 60_000, tierTarget: 5});
    expect(after[0]).toMatchObject({status: "COMPLETED", creditedRewardPaise: 30_000});

    // Refreshing again, or the scheduled settlement run, never pays twice.
    await refreshRiderRewardProgress("rider_1", AFTER_PERIOD + 60_000, db);
    await settleQualifiedRiderRewardPeriods(AFTER_PERIOD + 120_000, db);
    expect(guaranteeJournals()).toHaveLength(1);
  });

  it("owes nothing when the rider already earned more than the guarantee", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign());
    await workDinner("rider_1", 5, 13_000);
    const after = await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    expect(after[0]?.guarantee).toMatchObject({eligibleEarningsPaise: 65_000, topUpPaise: 0, finalEarningsPaise: 65_000});
    expect(after[0]?.status).toBe("COMPLETED");
    expect(guaranteeJournals()).toHaveLength(0);
  });

  it("uses the highest tier reached and never adds tiers together", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign());
    await workDinner("rider_1", 4, 6_000);
    await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    // 4 deliveries reach only the Rs 300 tier: 300 - 240 = 60.
    expect(guaranteeJournals()[0]?.entries.find((entry) => entry.accountId.startsWith("expense:"))?.amountPaise).toBe(6_000);
  });

  it("pays nothing when the delivery target was not reached", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign());
    await workDinner("rider_1", 2, 6_000);
    const after = await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    expect(after[0]?.guarantee?.tierTarget).toBe(0);
    expect(after[0]?.status).toBe("EXPIRED");
    expect(guaranteeJournals()).toHaveLength(0);
  });

  it("pays nothing when the reject limit was broken", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign());
    await workDinner("rider_1", 5, 6_000);
    seedEvent(activity("rider_1", "rej1", "ORDER_REJECTED", at("2026-08-26T20:00:00"), "x1"));
    seedEvent(activity("rider_1", "rej2", "ORDER_REJECTED", at("2026-08-26T20:30:00"), "x2"));
    const after = await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    expect(after[0]?.status).toBe("FAILED");
    expect(guaranteeJournals()).toHaveLength(0);
  });

  it("pays nothing when the required online time was not completed", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign({
      conditionGroups: [{groupId: "dinner", title: "Dinner login", minimumSlotsRequired: 1, slots: [{
        slotId: "dinner", label: "Dinner", startMinute: DINNER_START, endMinute: DINNER_END,
        requiredDurationMinutes: 240, requiredActiveDurationMinutes: null, requiredOnlinePercentage: null,
        minimumOrdersAccepted: null, minimumCompletedDeliveries: null, offlineToleranceMinutes: 10,
        gracePeriodMinutes: 0, overlapMode: "no_double_count", disabledCityNames: [],
      }]}],
    }));
    // Online only 19:00-20:30, but still delivers five orders.
    seedEvent(activity("rider_1", "on", "ONLINE", at("2026-08-26T19:00:00")));
    for (let t = at("2026-08-26T19:05:00"); t < at("2026-08-26T20:30:00"); t += 5 * 60_000) {
      seedEvent(activity("rider_1", `hb${t}`, "HEARTBEAT", t));
    }
    seedEvent(activity("rider_1", "off", "OFFLINE", at("2026-08-26T20:30:00")));
    for (let index = 0; index < 5; index += 1) {
      await deliver("rider_1", `o${index}`, at("2026-08-26T19:10:00") + index * 15 * 60_000, 6_000);
    }
    await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    expect(guaranteeJournals()).toHaveLength(0);
  });

  it("does not count tips against the guarantee unless the campaign says so", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign());
    await workDinner("rider_1", 5, 6_000, 2_000);
    const after = await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    expect(after[0]?.guarantee?.breakdown.tipsPaise).toBe(10_000);
    expect(after[0]?.guarantee?.eligibleEarningsPaise).toBe(30_000);
    expect(after[0]?.creditedRewardPaise).toBe(30_000);
  });

  it("counts tips when the campaign explicitly includes them", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign({guaranteeComponents: ["trip_pay", "tips"]}));
    await workDinner("rider_1", 5, 6_000, 2_000);
    const after = await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    expect(after[0]?.creditedRewardPaise).toBe(20_000);
  });

  it("never spends more than the campaign budget, even across riders", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign({budgetPaise: 40_000}));
    await workDinner("rider_1", 5, 6_000);
    await workDinner("rider_2", 5, 6_000);
    await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    await refreshRiderRewardProgress("rider_2", AFTER_PERIOD, db);
    const paid = guaranteeJournals().map((journal) => journal.entries.find((entry) => entry.accountId.startsWith("expense:"))?.amountPaise);
    expect(paid.sort()).toEqual([10_000, 30_000]);
    expect(db.read("riderGuaranteeBudgets/dinner-guarantee")).toMatchObject({spentPaise: 40_000});
  });

  it("closes the guarantee to riders beyond the configured limit", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign({maxEligibleRiders: 1}));
    await workDinner("rider_1", 5, 6_000);
    await refreshRiderRewardProgress("rider_1", at("2026-08-26T19:45:00"), db);
    await workDinner("rider_2", 5, 6_000);
    const second = await refreshRiderRewardProgress("rider_2", at("2026-08-26T19:50:00"), db);
    expect(second[0]?.guarantee?.status).toBe("seats_full");
    await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    await refreshRiderRewardProgress("rider_2", AFTER_PERIOD, db);
    expect(guaranteeJournals().map((journal) => journal.metadata.periodKey && journal.entries.some((entry) =>
      entry.accountId === "liability:rider-earnings:rider_2"))).toEqual([false]);
  });

  it("pauses settlement while guarantees are switched off, and settles once switched back on", async () => {
    db.seed("private/riderRewards/campaigns/dinner-guarantee", guaranteeCampaign());
    db.seed("economicsControl/current", {flags: {riderGuarantee: false}});
    await workDinner("rider_1", 5, 6_000);
    const paused = await refreshRiderRewardProgress("rider_1", AFTER_PERIOD, db);
    expect(paused[0]?.guarantee?.status).toBe("paused");
    expect(guaranteeJournals()).toHaveLength(0);

    db.seed("economicsControl/current", {flags: {riderGuarantee: true}});
    clearEconomicsControlCache();
    await settleQualifiedRiderRewardPeriods(AFTER_PERIOD + 60_000, db);
    expect(guaranteeJournals()).toHaveLength(1);
  });
});
