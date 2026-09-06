import type {DecodedIdToken} from "firebase-admin/auth";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }},
}));

import {ROOT} from "../src/config";
import {createLedgerJournal, type LedgerJournal} from "../src/domain/ledger";
import {LEDGER_JOURNALS_ROOT, buildOnlineOrderDeliveryJournal} from "../src/services/ledger";
import {
  __test,
  RIDER_REWARD_ACTIVITY_EVENTS_ROOT,
  RIDER_REWARD_CAMPAIGNS_ROOT,
  RIDER_REWARD_SETTINGS_ROOT,
  RIDER_REWARD_SESSION_DAYS_ROOT,
  evaluateRiderRewardsForDeliveredOrder,
  readRiderRewardsAdminDashboard,
  readRiderRewardsDashboard,
  updateRiderRewardSettings,
  upsertRiderRewardCampaign,
  type RiderRewardsDatabase,
} from "../src/services/riderRewards";
import type {SavrivoOrder} from "../src/types";

const riderId = "rider-1";
const inviterId = "rider-mentor";
const ownerToken = {
  savrivoRole: "owner",
  email: "owner@scraveit.test",
} as DecodedIdToken;

type TreeRecord = Record<string, unknown>;

class MemoryRiderRewardsDatabase implements RiderRewardsDatabase {
  private tree: TreeRecord = {};

  seed(path: string, value: unknown): void {
    this.write(path, value);
  }

  read(path: string): unknown {
    return this.lookup(path);
  }

  ref(path: string) {
    const database = this;
    let orderedByChild: string | null = null;
    let rangeStart: string | number | null = null;
    let rangeEnd: string | number | null = null;
    let limitedToFirst: number | null = null;
    let limitedToLast: number | null = null;
    const chain = {
      orderByChild(child: string) {
        orderedByChild = child;
        return chain;
      },
      startAt(value: string | number) {
        rangeStart = value;
        return chain;
      },
      endAt(value: string | number) {
        rangeEnd = value;
        return chain;
      },
      limitToFirst(limit: number) {
        limitedToFirst = limit;
        return chain;
      },
      limitToLast(limit: number) {
        limitedToLast = limit;
        return chain;
      },
      async get() {
        let value = database.lookup(path);
        if (orderedByChild && value && typeof value === "object" && !Array.isArray(value)) {
          let entries = Object.entries(value as TreeRecord)
            .filter(([, candidate]) => {
              const childValue = ((candidate as TreeRecord) ?? {})[orderedByChild] ?? null;
              if (rangeStart !== null && compareQueryValue(childValue, rangeStart) < 0) return false;
              if (rangeEnd !== null && compareQueryValue(childValue, rangeEnd) > 0) return false;
              return true;
            })
            .sort((left, right) => {
              const leftValue = Number(((left[1] as TreeRecord) ?? {})[orderedByChild] ?? 0);
              const rightValue = Number(((right[1] as TreeRecord) ?? {})[orderedByChild] ?? 0);
              return leftValue - rightValue || left[0].localeCompare(right[0]);
            });
          if (limitedToFirst != null) entries = entries.slice(0, limitedToFirst);
          if (limitedToLast != null) entries = entries.slice(-limitedToLast);
          value = Object.fromEntries(entries);
        }
        return {val: () => clone(value ?? null)};
      },
      async set(value: unknown) {
        database.write(path, value);
      },
      async transaction(update: (current: unknown) => unknown) {
        const current = clone(database.lookup(path) ?? null);
        const next = update(current);
        if (next === undefined) {
          return {committed: false, snapshot: {val: () => clone(database.lookup(path) ?? null)}};
        }
        database.write(path, next);
        return {committed: true, snapshot: {val: () => clone(database.lookup(path) ?? null)}};
      },
    };
    return chain;
  }

  private lookup(path: string): unknown {
    const segments = split(path);
    let current: unknown = this.tree;
    for (const segment of segments) {
      if (!current || typeof current !== "object" || Array.isArray(current)) return null;
      current = (current as TreeRecord)[segment];
      if (current === undefined) return null;
    }
    return current;
  }

  private write(path: string, value: unknown): void {
    const segments = split(path);
    if (!segments.length) {
      this.tree = value && typeof value === "object" && !Array.isArray(value)
        ? clone(value as TreeRecord)
        : {};
      return;
    }
    let current: TreeRecord = this.tree;
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index]!;
      const next = current[segment];
      if (!next || typeof next !== "object" || Array.isArray(next)) current[segment] = {};
      current = current[segment] as TreeRecord;
    }
    const leaf = segments[segments.length - 1]!;
    if (value === null) delete current[leaf];
    else current[leaf] = clone(value);
  }
}

function split(path: string): string[] {
  return String(path || "").split("/").filter(Boolean);
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function compareQueryValue(left: unknown, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right));
}

function seedApprovedRider(database: MemoryRiderRewardsDatabase, id: string, extra: Record<string, unknown> = {}): void {
  database.seed(`${ROOT}/riders/${id}`, {
    status: "approved",
    city: "Nellore",
    rating: 4.8,
    ...extra,
  });
}

function seedCoverage(database: MemoryRiderRewardsDatabase, id: string): void {
  database.seed(`${ROOT}/private/financialLedger/coverage/riders/${id}`, {
    schemaVersion: 1,
    riderId: id,
    historicalBackfillComplete: true,
    verifiedAt: 1,
  });
}

function seedWallet(database: MemoryRiderRewardsDatabase, id: string, outstandingPaise = 0): void {
  database.seed(`${ROOT}/riderWallets/${id}`, {
    codOutstanding: outstandingPaise / 100,
    codOutstandingLimitPaise: 50_000,
    codRemittanceReservedPaise: 0,
    codBlocked: false,
  });
}

function seedRewardSessionDay(database: MemoryRiderRewardsDatabase, id: string, dayKey: string, at: number): void {
  database.seed(`${RIDER_REWARD_SESSION_DAYS_ROOT}/${id}/${dayKey}`, {
    schemaVersion: 1,
    riderId: id,
    dayKey,
    firstSeenAt: at,
    lastSeenAt: at,
  });
}

function seedRewardActivityEvent(
  database: MemoryRiderRewardsDatabase,
  riderIdValue: string,
  eventId: string,
  type: string,
  occurredAt: number,
  orderId = "",
): void {
  database.seed(`${RIDER_REWARD_ACTIVITY_EVENTS_ROOT}/${riderIdValue}/${eventId}`, {
    schemaVersion: 1,
    riderId: riderIdValue,
    eventId,
    type,
    occurredAt,
    orderId,
    metadata: {},
  });
}

function seedCompletedSessionSlot(
  database: MemoryRiderRewardsDatabase,
  riderIdValue: string,
  prefix: string,
  startAt: number,
  endAt: number,
  heartbeatMs = 60_000,
): void {
  seedRewardActivityEvent(database, riderIdValue, `${prefix}:online`, "ONLINE", startAt);
  for (let cursor = startAt + heartbeatMs; cursor < endAt; cursor += heartbeatMs) {
    seedRewardActivityEvent(database, riderIdValue, `${prefix}:hb:${cursor}`, "HEARTBEAT", cursor);
  }
  seedRewardActivityEvent(database, riderIdValue, `${prefix}:offline`, "OFFLINE", endAt);
}

function deliveryJournal(orderId: string, occurredAt: number): LedgerJournal {
  return buildOnlineOrderDeliveryJournal({
    orderId,
    restaurantId: "restaurant-1",
    riderId,
    occurredAt,
    paymentProvider: "phonepe",
    providerTransactionId: `provider-${orderId}`,
    grossAmountPaise: 14_000,
    restaurantPayablePaise: 9_000,
    platformCommissionPaise: 1_500,
    platformFeePaise: 700,
    taxPayablePaise: 300,
    riderDeliveryEarningPaise: 2_000,
    riderTipPaise: 500,
  });
}

function payoutJournal(amountPaise: number, occurredAt: number): LedgerJournal {
  return createLedgerJournal({
    eventType: "rider_payout",
    eventId: `rider-payout:${occurredAt}`,
    occurredAt,
    actorId: "system:settlements",
    metadata: {reference: `settlement-${occurredAt}`},
    postings: [
      {
        accountId: `liability:rider-earnings:${riderId}`,
        side: "debit",
        amountPaise,
        memo: "Rider payout sent",
      },
      {
        accountId: "asset:rider-settlement-clearing",
        side: "credit",
        amountPaise,
        memo: "Rider payout sent",
      },
    ],
  });
}

function sampleCampaign(now: number) {
  return {
    internalName: "nellore-lunch-surge",
    title: "Lunch surge",
    subtitle: "₹30 extra on lunch deliveries",
    description: "Auto-applies for lunch deliveries in Nellore.",
    kind: "per_order_bonus" as const,
    displayType: "surge" as const,
    section: "lunch" as const,
    rewardAmountPaise: 3_000,
    milestones: [],
    window: "daily" as const,
    startAt: now - 60_000,
    endAt: now + 7 * 24 * 60 * 60 * 1_000,
    eligibleDays: [],
    timeSlots: [{label: "Lunch", startMinute: 11 * 60, endMinute: 15 * 60}],
    cityNames: ["Nellore"],
    zoneNames: [],
    restaurantIds: [],
    riderIds: [],
    minCompletedTrips: 0,
    rainOnly: false,
    requireDailyLoginSession: false,
    stacking: "stack" as const,
    priority: 50,
    visible: true,
    active: true,
    archived: false,
  };
}

function deliveredOrder(orderId: string, deliveredAt: number): SavrivoOrder {
  return {
    id: orderId,
    schemaVersion: 1,
    idempotencyKey: `idem-${orderId}`,
    customerId: "customer-1",
    customerName: "Customer One",
    customerPhone: "9999999999",
    restaurantId: "restaurant-1",
    restaurant: "The Waffle Spot",
    restaurantLocation: {address: "Main road", lat: 14.0, lng: 79.0},
    items: [{
      itemId: "item-1",
      name: "Classic waffle",
      quantity: 1,
      price: 120,
      variant: "",
      variantPrice: 0,
      addOns: [],
      addOnTotal: 0,
      note: "",
      diet: "veg",
    }],
    pricing: {
      subtotal: 120,
      discount: 0,
      deliveryFee: 20,
      smallOrderFee: 0,
      lateNightFee: 0,
      rainFee: 0,
      surgeFee: 0,
      platformFee: 10,
      tax: 10,
      tip: 5,
      currency: "INR",
      source: "catalog_snapshot_v3",
    },
    pricingContext: {
      distanceKm: 2,
      platformFeeRule: "default",
      weatherSeverity: "",
      surgeActiveOrders: 0,
      pricedAt: deliveredAt,
    },
    total: 155,
    coupon: "",
    paymentMethod: "upi",
    paymentState: "paid",
    deliveryMode: "asap",
    address: {
      id: "address-1",
      label: "Home",
      area: "Magunta Layout",
      address: "Street 1",
      phone: "9999999999",
      source: "manual",
      updatedAt: deliveredAt,
      lat: 14.01,
      lng: 79.01,
      city: "Nellore",
    },
    instructions: "",
    contactless: false,
    status: "Delivered",
    statusHistory: {},
    createdAt: deliveredAt - 30 * 60 * 1_000,
    updatedAt: deliveredAt,
    deliveredAt,
    etaMin: 20,
    etaMax: 30,
    riderId,
    riderName: "Rider One",
  };
}

describe("rider rewards engine", () => {
  it("accrues the ₹500 inviter referral reward exactly once when the referred rider reaches 25 completed orders", async () => {
    const database = new MemoryRiderRewardsDatabase();
    const now = new Date("2026-08-26T12:30:00+05:30").getTime();
    seedApprovedRider(database, inviterId);
    const inviterReferral = await __test.ensureRiderReferralIdentity(inviterId, database, () => now);
    seedApprovedRider(database, riderId, {referredByCode: inviterReferral.referralCode});
    seedCoverage(database, riderId);
    seedWallet(database, riderId, 0);

    for (let index = 1; index <= 24; index += 1) {
      const historical = deliveryJournal(`order-${index}`, now - (25 - index) * 60_000);
      database.seed(`${LEDGER_JOURNALS_ROOT}/${historical.journalId}`, historical);
    }
    const delivery = deliveryJournal("order-25", now);
    database.seed(`${LEDGER_JOURNALS_ROOT}/${delivery.journalId}`, delivery);
    await updateRiderRewardSettings("owner-1", ownerToken, {
      operationId: "reward-settings-1",
      referralProgramActive: true,
      inviterRewardPaise: 50_000,
      inviteeRewardPaise: 0,
      referralMinCompletedTrips: 25,
      referralMaxRewardsPerRider: 0,
    }, database, () => now);
    await upsertRiderRewardCampaign("owner-1", ownerToken, {
      operationId: "reward-campaign-1",
      campaignId: "lunch-surge",
      campaign: sampleCampaign(now),
    }, database, () => now);

    const order = deliveredOrder("order-25", now);
    const first = await evaluateRiderRewardsForDeliveredOrder(order, database, () => now);
    const second = await evaluateRiderRewardsForDeliveredOrder(order, database, () => now);

    expect(first.awardedJournalIds).toHaveLength(2);
    expect(second.awardedJournalIds).toHaveLength(2);
    const ledger = database.read(LEDGER_JOURNALS_ROOT) as Record<string, unknown>;
    expect(Object.keys(ledger)).toHaveLength(27);
    expect(Object.values(ledger).filter((journal) => (journal as LedgerJournal).eventType === "rider_incentive")).toHaveLength(1);
    expect(Object.values(ledger).filter((journal) => (journal as LedgerJournal).eventType === "rider_referral_reward")).toHaveLength(1);
  });

  it("returns a unique 6-digit referral code and counts riders who joined with that code or link", async () => {
    const database = new MemoryRiderRewardsDatabase();
    const now = new Date("2026-08-26T13:00:00+05:30").getTime();
    seedApprovedRider(database, riderId);
    seedApprovedRider(database, inviterId);
    const referralIdentity = await __test.ensureRiderReferralIdentity(riderId, database, () => now);
    seedApprovedRider(database, "rider-joined", {referredByCode: `https://join.scraveit.app/rider?ref=${referralIdentity.referralCode}`});
    seedCoverage(database, riderId);
    seedWallet(database, riderId, 0);

    const delivery = deliveryJournal("order-2", now - 60_000);
    const payout = payoutJournal(1_000, now);
    database.seed(`${LEDGER_JOURNALS_ROOT}/${delivery.journalId}`, delivery);
    database.seed(`${LEDGER_JOURNALS_ROOT}/${payout.journalId}`, payout);
    await updateRiderRewardSettings("owner-1", ownerToken, {
      operationId: "reward-settings-2",
      payoutMinimumPaise: 2_000,
      referralProgramActive: true,
      inviterRewardPaise: 50_000,
      inviteeRewardPaise: 0,
      referralMinCompletedTrips: 25,
      referralMaxRewardsPerRider: 0,
    }, database, () => now);
    await upsertRiderRewardCampaign("owner-1", ownerToken, {
      operationId: "reward-campaign-2",
      campaignId: "lunch-surge",
      campaign: sampleCampaign(now),
    }, database, () => now);

    const dashboard = await readRiderRewardsDashboard("admin-1", ownerToken, {
      riderId,
      referenceAt: now,
      ledgerLimit: 250,
      historyLimit: 100,
      campaignLimit: 50,
    }, database, () => now);

    expect(dashboard.financial.complete).toBe(true);
    expect(dashboard.weekBars).toHaveLength(7);
    expect(dashboard.payout.minimumPayoutPaise).toBe(2_000);
    expect(dashboard.payout.entries).toHaveLength(1);
    expect(dashboard.offers[0]).toMatchObject({
      campaignId: "lunch-surge",
      displayType: "surge",
    });
    expect(dashboard.referral.active).toBe(true);
    expect(dashboard.referral.referralCode).toBe(referralIdentity.referralCode);
    expect(dashboard.referral.referralCode).toMatch(/^\d{6}$/);
    expect(dashboard.referral.referredRiderCount).toBe(1);
  });

  it("accepts a pasted referral link and extracts the 6-digit code", () => {
    expect(__test.normalizeReferralInput("https://join.scraveit.app/rider?ref=123456")).toBe("123456");
    expect(__test.normalizeReferralInput("Invite code 654321")).toBe("654321");
  });

  it("selects the latest earned day in the chosen week when the requested day has no earnings yet", async () => {
    const database = new MemoryRiderRewardsDatabase();
    const now = new Date("2026-08-27T15:00:00+05:30").getTime();
    seedApprovedRider(database, riderId);
    seedCoverage(database, riderId);
    seedWallet(database, riderId, 0);

    const wednesdayDelivery = deliveryJournal("order-3", new Date("2026-08-26T13:00:00+05:30").getTime());
    database.seed(`${LEDGER_JOURNALS_ROOT}/${wednesdayDelivery.journalId}`, wednesdayDelivery);

    const dashboard = await readRiderRewardsDashboard("admin-1", ownerToken, {
      riderId,
      referenceAt: now,
      ledgerLimit: 250,
      historyLimit: 100,
      campaignLimit: 50,
    }, database, () => now);

    expect(dashboard.selectedDayKey).toBe("2026-08-26");
    expect(dashboard.selectedDay.tripEarningsPaise).toBe(2_000);
    expect(dashboard.weekBars.find((bar) => bar.dayKey === "2026-08-26")?.totalEarnedPaise).toBe(2_500);
  });

  it("keeps milestone offers visible for the selected day even before a listed slot begins", async () => {
    const database = new MemoryRiderRewardsDatabase();
    const now = new Date("2026-08-27T10:33:00+05:30").getTime();
    seedApprovedRider(database, riderId);
    seedCoverage(database, riderId);
    seedWallet(database, riderId, 0);

    await upsertRiderRewardCampaign("owner-1", ownerToken, {
      operationId: "reward-campaign-visibility-1",
      campaignId: "daily-incentive",
      campaign: {
        ...sampleCampaign(now),
        internalName: "daily-incentive",
        title: "Daily Incentive",
        subtitle: "Complete 8 orders for ₹50 and 13 orders for ₹80",
        description: "Visible before the first slot opens, but still backend-qualified by delivery facts.",
        kind: "milestone_bonus",
        displayType: "daily_incentive",
        section: "special",
        rewardAmountPaise: undefined,
        milestones: [
          {target: 8, rewardAmountPaise: 5_000, label: "Complete 8 orders"},
          {target: 13, rewardAmountPaise: 8_000, label: "Complete 13 orders"},
        ],
        window: "daily",
        timeSlots: [
          {label: "Lunch", startMinute: 11 * 60, endMinute: 16 * 60},
          {label: "Night", startMinute: 19 * 60, endMinute: 23 * 60},
        ],
      },
    }, database, () => now);

    const dashboard = await readRiderRewardsDashboard("admin-1", ownerToken, {
      riderId,
      referenceAt: now,
      ledgerLimit: 250,
      historyLimit: 100,
      campaignLimit: 50,
    }, database, () => now);

    expect(dashboard.offers).toHaveLength(1);
    expect(dashboard.offers[0]).toMatchObject({
      campaignId: "daily-incentive",
      status: "ACTIVE",
      activeNow: true,
    });
  });

  it("does not retroactively lock a newly-enabled weekly incentive during the current week", async () => {
    const database = new MemoryRiderRewardsDatabase();
    const now = new Date("2026-08-27T18:19:00+05:30").getTime();
    seedApprovedRider(database, riderId);
    seedCoverage(database, riderId);
    seedWallet(database, riderId, 0);

    await upsertRiderRewardCampaign("owner-1", ownerToken, {
      operationId: "reward-campaign-login-rule-grace",
      campaignId: "weekly-incentive",
      campaign: {
        ...sampleCampaign(now),
        internalName: "weekly-incentive",
        title: "Incentive Targets",
        subtitle: "Weekly trip milestones",
        description: "Requires two valid login sessions per day once the rule becomes active.",
        kind: "milestone_bonus",
        displayType: "trip_milestone",
        section: "special",
        rewardAmountPaise: undefined,
        milestones: [
          {target: 8, rewardAmountPaise: 5_000, label: "Complete 8 orders"},
          {target: 13, rewardAmountPaise: 8_000, label: "Complete 13 orders"},
        ],
        window: "weekly",
        timeSlots: [
          {label: "Lunch", startMinute: 11 * 60, endMinute: 15 * 60},
          {label: "Night", startMinute: 19 * 60, endMinute: 23 * 60},
        ],
        requireDailyLoginSession: true,
      },
    }, database, () => now);

    const dashboard = await readRiderRewardsDashboard("admin-1", ownerToken, {
      riderId,
      referenceAt: now,
      ledgerLimit: 250,
      historyLimit: 100,
      campaignLimit: 50,
    }, database, () => now);

    expect(dashboard.offers[0]).toMatchObject({
      campaignId: "weekly-incentive",
      status: "ACTIVE",
      eligibilityMessage: "",
    });
    expect(dashboard.offers[0]?.conditions[0]).toContain("Complete at least 2 valid login sessions/shifts every required day in this week");
    expect(dashboard.loginSessionTracker).toMatchObject({
      enabled: true,
      campaignId: "weekly-incentive",
      requiredSessionsPerDay: 2,
      loggedDaysInWeek: 0,
      requiredDaysCompletedSoFar: 0,
      requiredDaysSoFar: 1,
      todayCompletedSessions: 0,
      todayRecorded: false,
      locked: false,
    });
    expect(dashboard.loginSessionTracker.days.map((day) => day.status)).toEqual([
      "inactive",
      "inactive",
      "inactive",
      "pending",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
  });

  it("locks a weekly incentive when a past day in the same week misses the login-session requirement", async () => {
    const database = new MemoryRiderRewardsDatabase();
    const now = new Date("2026-08-27T18:19:00+05:30").getTime();
    seedApprovedRider(database, riderId);
    seedCoverage(database, riderId);
    seedWallet(database, riderId, 0);
    seedCompletedSessionSlot(
      database,
      riderId,
      "mon-lunch",
      new Date("2026-08-24T11:00:00+05:30").getTime(),
      new Date("2026-08-24T15:00:00+05:30").getTime(),
    );
    seedCompletedSessionSlot(
      database,
      riderId,
      "mon-night",
      new Date("2026-08-24T19:00:00+05:30").getTime(),
      new Date("2026-08-24T23:00:00+05:30").getTime(),
    );
    seedCompletedSessionSlot(
      database,
      riderId,
      "wed-lunch",
      new Date("2026-08-26T11:00:00+05:30").getTime(),
      new Date("2026-08-26T15:00:00+05:30").getTime(),
    );
    seedCompletedSessionSlot(
      database,
      riderId,
      "wed-night",
      new Date("2026-08-26T19:00:00+05:30").getTime(),
      new Date("2026-08-26T23:00:00+05:30").getTime(),
    );

    const activatedAt = new Date("2026-08-24T06:00:00+05:30").getTime();
    await upsertRiderRewardCampaign("owner-1", ownerToken, {
      operationId: "reward-campaign-login-rule-lock",
      campaignId: "weekly-incentive-lock",
      campaign: {
        ...sampleCampaign(activatedAt),
        internalName: "weekly-incentive-lock",
        title: "Incentive Targets",
        subtitle: "Weekly trip milestones",
        description: "Requires two valid login sessions every day in the active week.",
        kind: "milestone_bonus",
        displayType: "trip_milestone",
        section: "special",
        rewardAmountPaise: undefined,
        milestones: [
          {target: 8, rewardAmountPaise: 5_000, label: "Complete 8 orders"},
          {target: 13, rewardAmountPaise: 8_000, label: "Complete 13 orders"},
        ],
        window: "weekly",
        timeSlots: [
          {label: "Lunch", startMinute: 11 * 60, endMinute: 15 * 60},
          {label: "Night", startMinute: 19 * 60, endMinute: 23 * 60},
        ],
        requireDailyLoginSession: true,
      },
    }, database, () => activatedAt);

    const dashboard = await readRiderRewardsDashboard("admin-1", ownerToken, {
      riderId,
      referenceAt: now,
      ledgerLimit: 250,
      historyLimit: 100,
      campaignLimit: 50,
    }, database, () => now);

    expect(dashboard.offers[0]).toMatchObject({
      campaignId: "weekly-incentive-lock",
      status: "FAILED",
    });
    expect(dashboard.offers[0]?.eligibilityMessage).toContain("Tue, 25 Aug");
    expect(dashboard.loginSessionTracker).toMatchObject({
      enabled: true,
      campaignId: "weekly-incentive-lock",
      requiredSessionsPerDay: 2,
      loggedDaysInWeek: 2,
      requiredDaysCompletedSoFar: 2,
      requiredDaysSoFar: 4,
      todayCompletedSessions: 0,
      todayRecorded: false,
      locked: true,
    });
    expect(dashboard.loginSessionTracker.days.find((day) => day.dayKey === "2026-08-25")?.status).toBe("missed");
    expect(dashboard.loginSessionTracker.message).toContain("Tue, 25 Aug");
  });

  it("exposes admin reward settings and campaign analytics through idempotent control-plane updates", async () => {
    const database = new MemoryRiderRewardsDatabase();
    const now = new Date("2026-08-26T14:00:00+05:30").getTime();
    seedApprovedRider(database, riderId);
    seedApprovedRider(database, "rider-2", {city: "Nellore", rating: 4.9});
    seedCoverage(database, riderId);
    seedWallet(database, riderId, 0);

    const settings = await updateRiderRewardSettings("owner-1", ownerToken, {
      operationId: "reward-settings-3",
      payoutMinimumPaise: 5_000,
      referralProgramActive: false,
    }, database, () => now);
    const firstSave = await upsertRiderRewardCampaign("owner-1", ownerToken, {
      operationId: "reward-campaign-3",
      campaignId: "weekly-boost",
      campaign: {
        ...sampleCampaign(now),
        internalName: "weekly-boost",
        title: "Weekly boost",
        subtitle: "Earn more after every 5 trips",
        kind: "milestone_bonus",
        displayType: "weekly_incentive",
        section: "special",
        rewardAmountPaise: undefined,
        milestones: [
          {target: 5, rewardAmountPaise: 2_000, label: "5 trips"},
          {target: 10, rewardAmountPaise: 5_000, label: "10 trips"},
        ],
        window: "weekly",
      },
    }, database, () => now);
    const retrySave = await upsertRiderRewardCampaign("owner-1", ownerToken, {
      operationId: "reward-campaign-3",
      campaignId: "weekly-boost",
      campaign: {
        ...sampleCampaign(now),
        internalName: "weekly-boost",
        title: "Weekly boost",
        subtitle: "Earn more after every 5 trips",
        kind: "milestone_bonus",
        displayType: "weekly_incentive",
        section: "special",
        rewardAmountPaise: undefined,
        milestones: [
          {target: 5, rewardAmountPaise: 2_000, label: "5 trips"},
          {target: 10, rewardAmountPaise: 5_000, label: "10 trips"},
        ],
        window: "weekly",
      },
    }, database, () => now);

    const dashboard = await readRiderRewardsAdminDashboard(ownerToken, {
      ledgerLimit: 200,
      campaignLimit: 50,
    }, database, () => now);

    expect(settings.payoutMinimumPaise).toBe(5_000);
    expect(firstSave.idempotent).toBe(true);
    expect(retrySave.idempotent).toBe(true);
    expect(dashboard.settings.payoutMinimumPaise).toBe(5_000);
    expect(dashboard.campaigns).toHaveLength(1);
    expect(dashboard.campaigns[0]).toMatchObject({
      eligibleRiderCount: 2,
      rewardJournalCount: 0,
      totalAccruedPaise: 0,
    });
  });
});
