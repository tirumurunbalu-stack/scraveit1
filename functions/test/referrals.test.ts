import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
  messaging: {sendEachForMulticast: vi.fn(async () => ({successCount: 0, failureCount: 0, responses: []}))},
  storage: {},
}));
vi.mock("../src/services/notifications", () => ({notifyRiderRewardUpdate: vi.fn(async () => undefined)}));

import {createLedgerJournal, deterministicJournalId, type LedgerJournal} from "../src/domain/ledger";
import {LEDGER_JOURNALS_COLLECTION, buildOnlineOrderDeliveryJournal} from "../src/services/ledger";
import {clearEconomicsControlCache} from "../src/services/economics";
import {
  __test,
  evaluateRiderRewardsForDeliveredOrder,
  expireRiderReferrals,
  normalizeRewardSettings,
  readRiderReferralOverviewForAdmin,
  readRiderRewardsDashboard,
  reverseRiderReferralDelivery,
  reviewRiderReferralForAdmin,
  simulateRiderReferralForAdmin,
  syncRiderReferralForProfile,
  updateRiderRewardSettings,
} from "../src/services/riderRewards";
import {
  applyCustomerReferralCode,
  ensureCustomerReferralCode,
  qualifyCustomerReferralOnDelivery,
  reviewCustomerReferralForAdmin,
} from "../src/services/customerReferrals";
import type {SavrivoOrder} from "../src/types";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const owner = {savrivoRole: "owner", email: "owner@scraveit.test"} as DecodedIdToken;
const NOW = new Date("2026-10-01T12:30:00+05:30").getTime();

function journals(database: InMemoryFirestore): LedgerJournal[] {
  return database.paths().filter((path) => path.startsWith(`${LEDGER_JOURNALS_COLLECTION}/`))
    .map((path) => database.read(path) as LedgerJournal);
}

// ---------------------------------------------------------------------------
// Rider referral: ₹5,000 after the referred rider's 250th successful delivery
// ---------------------------------------------------------------------------

describe("rider referral programme", () => {
  let database: InMemoryFirestore;
  let mentorCode = "";
  const DAY = 24 * 60 * 60 * 1000;

  function seedDelivered(riderId: string, count: number, from = 1, extra: Record<string, unknown> = {}) {
    for (let index = from; index < from + count; index += 1) {
      database.seed(`orders/${riderId}-o${index}`, {
        id: `${riderId}-o${index}`, riderId, customerId: "c", restaurantId: "r1", status: "Delivered",
        deliveredAt: NOW - 1_000_000 + index, updatedAt: NOW - 1_000_000 + index, paymentState: "paid", ...extra,
      });
    }
  }

  function order(riderId: string, orderId: string, at = NOW): SavrivoOrder {
    return {id: orderId, riderId, customerId: "c", restaurantId: "r1", status: "Delivered", deliveredAt: at, updatedAt: at,
      createdAt: at - 1, paymentState: "paid", pricing: {subtotal: 120}, address: {area: "x"}} as unknown as SavrivoOrder;
  }

  /** Seeds the order document, then runs the delivered-order handler. */
  async function deliver(riderId: string, orderId: string, at = NOW) {
    const delivered = order(riderId, orderId, at);
    database.seed(`orders/${orderId}`, delivered as unknown as Record<string, unknown>);
    return evaluateRiderRewardsForDeliveredOrder(delivered, database, () => at);
  }

  function seedReferred(riderId: string, extra: Record<string, unknown> = {}) {
    database.seed(`riders/${riderId}`, {
      status: "approved", city: "Nellore", fullName: `Ravi ${riderId} Kumar`, phone: `98480${riderId.length}0000`.slice(0, 10),
      submittedAt: NOW - DAY, referredByCode: mentorCode, ...extra,
    });
  }

  async function settings(changes: Record<string, unknown> = {}, at = NOW) {
    await updateRiderRewardSettings("owner", owner, {
      operationId: `settings-${Math.random().toString(36).slice(2)}`, referralProgramActive: true, ...changes,
    }, database, () => at);
  }

  async function setUp(changes: Record<string, unknown> = {}) {
    database.seed("riders/mentor", {status: "approved", city: "Nellore", fullName: "Suresh Babu", phone: "9000000001"});
    mentorCode = (await __test.ensureRiderReferralIdentity("mentor", database, () => NOW)).referralCode;
    await settings(changes);
  }

  const referralJournals = () => journals(database).filter((journal) => journal.eventType === "rider_referral_reward");
  const referral = (riderId: string) => database.read(`riderReferrals/${riderId}`) as Record<string, unknown>;
  const budget = () => database.read("programBudgets/rider_referral") as Record<string, number> | undefined;

  beforeEach(() => {
    database = new InMemoryFirestore();
    clearEconomicsControlCache();
  });

  it("defaults to ₹5,000 after 250 successful delivered orders, stored as integer paise", () => {
    const defaults = normalizeRewardSettings(null);
    expect(defaults.inviterRewardPaise).toBe(500_000);
    expect(defaults.referralMinCompletedTrips).toBe(250);
    expect(defaults.inviteeRewardPaise).toBe(0);
    expect(defaults.referralProgrammeVersion).toBe(2);
  });

  it("upgrades settings saved under the old ₹500 / 25 default, but keeps deliberately changed values", () => {
    const oldDefault = normalizeRewardSettings({inviterRewardPaise: 50_000, referralMinCompletedTrips: 25});
    expect(oldDefault.inviterRewardPaise).toBe(500_000);
    expect(oldDefault.referralMinCompletedTrips).toBe(250);
    expect(oldDefault.referralLegacyTerms).toMatchObject({inviterRewardPaise: 50_000, qualifyingDeliveredOrders: 25});
    const custom = normalizeRewardSettings({inviterRewardPaise: 75_000, referralMinCompletedTrips: 40});
    expect(custom.inviterRewardPaise).toBe(75_000);
    expect(custom.referralMinCompletedTrips).toBe(40);
    const versioned = normalizeRewardSettings({referralProgrammeVersion: 3, inviterRewardPaise: 50_000, referralMinCompletedTrips: 25});
    expect(versioned.inviterRewardPaise).toBe(50_000);
  });

  it("pays nothing at 249 deliveries and ₹5,000 exactly once at the 250th, with city attribution", async () => {
    await setUp();
    seedReferred("new1");
    seedDelivered("new1", 248);
    await deliver("new1", "new1-249");
    expect(referral("new1")).toMatchObject({status: "in_progress", deliveredCount: 249, reservedPaise: 500_000});
    expect(referralJournals()).toHaveLength(0);
    expect(budget()).toMatchObject({reservedPaise: 500_000, spentPaise: 0});

    const at250 = await deliver("new1", "new1-250");
    expect(at250.awardedJournalIds).toHaveLength(1);
    expect(referral("new1")).toMatchObject({status: "paid", deliveredCount: 250, reservedPaise: 0, qualifyingOrderId: "new1-250"});
    const paid = referralJournals();
    expect(paid).toHaveLength(1);
    expect(paid[0]?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({accountId: "expense:rider-rewards:referral", side: "debit", amountPaise: 500_000}),
      expect.objectContaining({accountId: "liability:rider-earnings:mentor", side: "credit", amountPaise: 500_000}),
    ]));
    expect(paid[0]?.metadata).toMatchObject({
      cityKey: "nellore", stateKey: "andhra-pradesh", countryKey: "in", campaignId: "rider_referral_program",
      programmeId: "rider_referral_program", programmeVersion: "2", inviterRiderId: "mentor", referredRiderId: "new1",
      referralId: "new1", costCategory: "rider_acquisition", budget: "rider_supply",
    });
    expect(budget()).toMatchObject({reservedPaise: 0, spentPaise: 500_000});
  });

  it("never pays twice: retries, orders 251 and 300, and repeated delivery events", async () => {
    await setUp();
    seedReferred("new1");
    seedDelivered("new1", 249);
    await deliver("new1", "new1-250");
    await deliver("new1", "new1-250");
    const retry = await deliver("new1", "new1-250");
    expect(retry.awardedJournalIds).toHaveLength(1); // same journal, not a new one
    await deliver("new1", "new1-251");
    seedDelivered("new1", 49, 252);
    const later = await deliver("new1", "new1-300");
    expect(later.awardedJournalIds).toHaveLength(0);
    expect(referralJournals()).toHaveLength(1);
    expect(budget()).toMatchObject({spentPaise: 500_000});
    expect(database.read("riderReferralInviterCounts/mentor")).toMatchObject({awardedCount: 1, openCount: 0});
  });

  it("counts each order once however often its delivery event is retried", async () => {
    await setUp({referralMinCompletedTrips: 3});
    seedReferred("new1");
    await deliver("new1", "a");
    await deliver("new1", "a");
    await deliver("new1", "a");
    await deliver("new1", "b");
    expect(referral("new1")).toMatchObject({status: "in_progress", deliveredCount: 2});
  });

  it("does not count cancelled, refunded or test orders", async () => {
    await setUp({referralMinCompletedTrips: 5});
    seedReferred("new1");
    seedDelivered("new1", 2);
    seedDelivered("new1", 1, 10, {paymentState: "refunded"});
    seedDelivered("new1", 1, 11, {testOrder: true});
    database.seed("orders/new1-cancelled", {riderId: "new1", status: "Cancelled"});
    await deliver("new1", "new1-live");
    expect(referral("new1")).toMatchObject({deliveredCount: 3});
    // A refund after the fact stops that order counting.
    await reverseRiderReferralDelivery(order("new1", "new1-live"), database, () => NOW);
    await reverseRiderReferralDelivery(order("new1", "new1-live"), database, () => NOW);
    expect(referral("new1")).toMatchObject({deliveredCount: 2});
  });

  it("freezes each referral's terms: a later change only applies to new referrals", async () => {
    await setUp();
    seedReferred("old1");
    seedDelivered("old1", 249);
    await syncRiderReferralForProfile("old1", database, () => NOW);
    expect(referral("old1")).toMatchObject({programmeVersion: 2, terms: {inviterRewardPaise: 500_000, qualifyingDeliveredOrders: 250}});

    await settings({inviterRewardPaise: 600_000, referralMinCompletedTrips: 300});
    expect(normalizeRewardSettings(database.read("private/riderRewards/meta/settings")).referralProgrammeVersion).toBe(3);
    expect(database.read("riderReferralProgrammeVersions/3")).toMatchObject({inviterRewardPaise: 600_000, qualifyingDeliveredOrders: 300});
    seedReferred("new1");
    await syncRiderReferralForProfile("new1", database, () => NOW);
    expect(referral("new1")).toMatchObject({programmeVersion: 3, terms: {inviterRewardPaise: 600_000, qualifyingDeliveredOrders: 300}});

    await deliver("old1", "old1-250");
    expect(referral("old1")).toMatchObject({status: "paid"});
    expect(referralJournals()[0]?.entries.find((entry) => entry.side === "credit")?.amountPaise).toBe(500_000);
    // A change to budget or dates alone is not a new version.
    await settings({referralBudgetPaise: 5_000_000});
    expect(normalizeRewardSettings(database.read("private/riderRewards/meta/settings")).referralProgrammeVersion).toBe(3);
  });

  it("keeps the ₹500 / 25 terms for riders who applied before terms were frozen", async () => {
    await setUp();
    seedReferred("early", {submittedAt: new Date("2026-09-01T10:00:00+05:30").getTime()});
    seedDelivered("early", 24);
    await deliver("early", "early-25");
    expect(referral("early")).toMatchObject({legacy: true, programmeVersion: 1, status: "paid"});
    expect(referralJournals()[0]?.entries.find((entry) => entry.side === "credit")?.amountPaise).toBe(50_000);
  });

  it("records a reward paid by an earlier release as paid, without paying again", async () => {
    await setUp();
    seedReferred("new1");
    const legacy = createLedgerJournal({
      eventType: "rider_referral_reward", eventId: "referral:new1:inviter:25", occurredAt: NOW - 1,
      metadata: {beneficiaryRole: "inviter"},
      postings: [
        {accountId: "expense:rider-rewards:referral", side: "debit", amountPaise: 50_000},
        {accountId: "liability:rider-earnings:mentor", side: "credit", amountPaise: 50_000},
      ],
    });
    expect(legacy.journalId).toBe(deterministicJournalId("rider_referral_reward", "referral:new1:inviter:25"));
    database.seed(`${LEDGER_JOURNALS_COLLECTION}/${legacy.journalId}`, legacy);
    seedDelivered("new1", 260);
    await deliver("new1", "new1-261");
    expect(referral("new1")).toMatchObject({status: "paid", statusReason: "paid_by_earlier_release"});
    expect(referralJournals()).toHaveLength(1);
  });

  it("reserves the budget at acceptance, so a full programme never promises money it cannot pay", async () => {
    await setUp({referralBudgetPaise: 800_000});
    seedReferred("new1");
    seedReferred("new2");
    seedDelivered("new1", 249);
    seedDelivered("new2", 249);
    await Promise.all([
      syncRiderReferralForProfile("new1", database, () => NOW),
      syncRiderReferralForProfile("new2", database, () => NOW),
    ]);
    const statuses = [referral("new1").status, referral("new2").status].sort();
    expect(statuses).toEqual(["in_progress", "not_eligible"]);
    const refused = referral("new1").status === "not_eligible" ? referral("new1") : referral("new2");
    expect(refused.statusReason).toBe("budget_exhausted");
    expect(budget()).toMatchObject({reservedPaise: 500_000});
    // Both reach 250: only ₹5,000 is ever spent against the ₹8,000 budget.
    for (const riderId of ["new1", "new2"]) await deliver(riderId, `${riderId}-250`);
    expect(referralJournals()).toHaveLength(1);
    expect(budget()).toMatchObject({spentPaise: 500_000, reservedPaise: 0});
    const dashboard = await readRiderRewardsDashboard("admin-1", owner, {
      riderId: "mentor", referenceAt: NOW, ledgerLimit: 250, historyLimit: 100, campaignLimit: 50,
    }, database, () => NOW);
    expect(dashboard.referral.programmeState).toBe("budget_exhausted");
    expect(dashboard.referral.active).toBe(false);
  });

  it("limits rewards per inviter, counting referrals still in progress", async () => {
    await setUp({referralMaxRewardsPerRider: 1});
    seedReferred("new1");
    seedReferred("new2");
    await syncRiderReferralForProfile("new1", database, () => NOW);
    await syncRiderReferralForProfile("new2", database, () => NOW + 1);
    expect(referral("new1").status).toBe("in_progress");
    expect(referral("new2")).toMatchObject({status: "not_eligible", statusReason: "inviter_limit_reached"});
  });

  it("refuses self-referral and test accounts, and ignores a later change of inviter", async () => {
    await setUp({referralMinCompletedTrips: 2});
    database.seed("riders/mentor", {status: "approved", city: "Nellore", fullName: "Suresh Babu", phone: "9000000001", referredByCode: mentorCode});
    await syncRiderReferralForProfile("mentor", database, () => NOW);
    expect(referral("mentor")).toMatchObject({status: "not_eligible", statusReason: "self_referral"});
    seedReferred("tester", {testAccount: true});
    await syncRiderReferralForProfile("tester", database, () => NOW);
    expect(referral("tester")).toMatchObject({status: "not_eligible", statusReason: "test_account"});

    seedReferred("new1");
    await syncRiderReferralForProfile("new1", database, () => NOW);
    database.seed("riders/other", {status: "approved", city: "Nellore", fullName: "Other Rider"});
    const otherCode = (await __test.ensureRiderReferralIdentity("other", database, () => NOW)).referralCode;
    seedReferred("new1", {referredByCode: otherCode});
    await deliver("new1", "x1");
    await deliver("new1", "x2");
    expect(referral("new1")).toMatchObject({inviterId: "mentor", status: "paid"});
    expect(referralJournals()[0]?.entries.some((entry) => entry.accountId === "liability:rider-earnings:mentor")).toBe(true);
  });

  it("holds a referral with matching identity details for an admin decision", async () => {
    await setUp({referralMinCompletedTrips: 2});
    seedReferred("twin", {phone: "9000000001"});
    await deliver("twin", "t1");
    await deliver("twin", "t2");
    expect(referral("twin")).toMatchObject({status: "review", riskFlags: ["same_phone"]});
    expect(referralJournals()).toHaveLength(0);
    const approved = await reviewRiderReferralForAdmin("owner", owner, {referredRiderId: "twin", decision: "approved"}, database, () => NOW);
    expect(approved.status).toBe("paid");
    expect(referralJournals()).toHaveLength(1);

    seedReferred("twin2", {phone: "9000000001"});
    await syncRiderReferralForProfile("twin2", database, () => NOW);
    const rejected = await reviewRiderReferralForAdmin("owner", owner, {referredRiderId: "twin2", decision: "rejected", note: "same person"},
      database, () => NOW);
    expect(rejected).toMatchObject({status: "rejected", statusReason: "rejected_by_admin", reservedPaise: 0});
    expect(budget()).toMatchObject({reservedPaise: 0});
  });

  it("expires at the deadline, stops counting after it, and releases the reserved budget", async () => {
    await setUp({referralMinCompletedTrips: 3, referralQualificationDays: 7});
    seedReferred("new1");
    await syncRiderReferralForProfile("new1", database, () => NOW);
    await deliver("new1", "d1", NOW + DAY);
    await deliver("new1", "late", NOW + 8 * DAY);
    expect(referral("new1")).toMatchObject({deliveredCount: 1, status: "expired", reservedPaise: 0});
    expect(budget()).toMatchObject({reservedPaise: 0});

    seedReferred("new2");
    await syncRiderReferralForProfile("new2", database, () => NOW);
    expect(await expireRiderReferrals(database, () => NOW + 8 * DAY)).toBe(1);
    expect(referral("new2")).toMatchObject({status: "expired", statusReason: "deadline_passed"});
    expect(database.read("riderReferralInviterCounts/mentor")).toMatchObject({openCount: 0});
  });

  it("ends the referral if the application is rejected before any delivery", async () => {
    await setUp();
    seedReferred("new1", {status: "submitted"});
    await syncRiderReferralForProfile("new1", database, () => NOW);
    expect(budget()).toMatchObject({reservedPaise: 500_000});
    seedReferred("new1", {status: "rejected"});
    await syncRiderReferralForProfile("new1", database, () => NOW);
    expect(referral("new1")).toMatchObject({status: "rejected", statusReason: "application_rejected"});
    expect(budget()).toMatchObject({reservedPaise: 0});
  });

  it("accepts nothing outside the programme dates or cities", async () => {
    await setUp({referralProgramEndAt: NOW - 1});
    seedReferred("new1");
    await syncRiderReferralForProfile("new1", database, () => NOW);
    expect(referral("new1")).toMatchObject({status: "not_eligible", statusReason: "programme_closed"});
    await settings({referralProgramEndAt: 0, referralCityNames: ["Guntur"]});
    seedReferred("new2");
    await syncRiderReferralForProfile("new2", database, () => NOW);
    expect(referral("new2")).toMatchObject({status: "not_eligible", statusReason: "city_not_eligible"});
    seedDelivered("new2", 260);
    await deliver("new2", "new2-last");
    expect(referralJournals()).toHaveLength(0);
  });

  it("shows the inviter each friend's progress from backend values", async () => {
    await setUp();
    seedReferred("new1");
    seedDelivered("new1", 182);
    await deliver("new1", "new1-183");
    const dashboard = await readRiderRewardsDashboard("admin-1", owner, {
      riderId: "mentor", referenceAt: NOW, ledgerLimit: 250, historyLimit: 100, campaignLimit: 50,
    }, database, () => NOW);
    expect(dashboard.referral).toMatchObject({
      active: true, programmeState: "active", inviterRewardPaise: 500_000, minCompletedTrips: 250,
      referredRiderCount: 1, pendingRewardPaise: 500_000, earnedRewardPaise: 0,
    });
    expect(dashboard.referral.referrals[0]).toMatchObject({
      name: "Ravi K.", delivered: 183, target: 250, remaining: 67, status: "in_progress", rewardPaise: 500_000,
    });
  });

  it("gives admins totals, exposure and a cost simulation from the configured reward", async () => {
    await setUp({referralMaxRewardsPerRider: 5, referralBudgetPaise: 10_000_000});
    seedReferred("new1");
    seedReferred("new2");
    seedDelivered("new1", 249);
    await deliver("new1", "new1-250");
    await syncRiderReferralForProfile("new2", database, () => NOW);
    const overview = await readRiderReferralOverviewForAdmin(owner, {}, database, () => NOW);
    expect(overview.counts).toMatchObject({paid: 1, in_progress: 1, total: 2, active: 1});
    expect(overview).toMatchObject({
      potentialLiabilityPaise: 500_000, paidRewardsPaise: 500_000, spendThisMonthPaise: 500_000,
      activatedReferredRiders: 1, averageCostPerQualifiedRiderPaise: 500_000,
    });
    expect(overview.budget).toMatchObject({spentPaise: 500_000, reservedPaise: 500_000, remainingPaise: 9_000_000});
    expect(overview.programme.maxExposurePerInviterPaise).toBe(2_500_000);
    expect(overview.rows.find((row) => row.referralId === "new1")).toMatchObject({
      inviterId: "mentor", target: 250, delivered: 250, status: "paid", cityKey: "nellore", programmeVersion: 2,
    });

    const simulation = await simulateRiderReferralForAdmin(owner, {
      expectedReferredRiders: 100, qualificationRatePercent: 30,
      monthlyOperatingProfitPaise: 30_000_000, monthlyExpansionFundPaise: 8_400_000,
    }, database);
    expect(simulation).toMatchObject({
      expectedQualified: 30, expectedCostPaise: 15_000_000, worstCaseCostPaise: 50_000_000,
      maxExposurePerInviterPaise: 2_500_000, budgetCoversExpected: false, budgetCoversWorstCase: false,
      operatingProfitAfterPaise: 15_000_000, expansionFundAfterPaise: 4_200_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Customer referral: rewarded only after a qualifying delivered order
// ---------------------------------------------------------------------------

describe("customer referral programme", () => {
  let database: InMemoryFirestore;
  const attribution = {cityKey: "nellore"};

  beforeEach(() => {
    database = new InMemoryFirestore();
    clearEconomicsControlCache();
    database.seed("economicsControl/current", {customerReferral: {
      active: true, referrerRewardPaise: 5_000, refereeRewardPaise: 5_000, minDeliveredOrders: 1,
      minOrderValuePaise: 19_900, rewardExpiryDays: 30, qualifyWithinDays: 30, budgetPaise: 10_000,
    }});
    database.seed("users/alice", {phone: "9000000001", addresses: [{lat: 14.44, lng: 79.98, phone: "9000000001", city: "Nellore"}]});
    database.seed("users/bob", {phone: "9000000002", addresses: [{lat: 14.46, lng: 79.99, phone: "9000000002", city: "Nellore"}]});
  });

  function deliveredOrder(customerId: string, orderId: string, subtotal: number): SavrivoOrder {
    const order = {id: orderId, customerId, status: "Delivered", pricing: {subtotal}, restaurantId: "r1"} as unknown as SavrivoOrder;
    database.seed(`orders/${orderId}`, order);
    return order;
  }

  it("does not reward signup, only the first qualifying delivered order, and only once", async () => {
    const code = await ensureCustomerReferralCode("alice", "install-alice-1", database);
    expect(code).toMatch(/^SC[A-Z0-9]{6}$/);
    expect(await ensureCustomerReferralCode("alice", "", database)).toBe(code);
    const applied = await applyCustomerReferralCode("bob", {code: `https://scraveit.app/r/${code}`, installId: "install-bob-1"}, database);
    expect(applied).toMatchObject({status: "pending", flags: [], rewardedOnSignup: false});
    expect(database.read("customerWallets/bob")).toBeNull();

    // A small first order does not qualify.
    expect(await qualifyCustomerReferralOnDelivery(deliveredOrder("bob", "o1", 150), attribution, database)).toBe(false);
    expect(await qualifyCustomerReferralOnDelivery(deliveredOrder("bob", "o2", 250), attribution, database)).toBe(true);
    expect(await qualifyCustomerReferralOnDelivery(deliveredOrder("bob", "o3", 250), attribution, database)).toBe(false);
    expect((database.read("customerWallets/bob") as {balancePaise: number}).balancePaise).toBe(5_000);
    expect((database.read("customerWallets/alice") as {balancePaise: number}).balancePaise).toBe(5_000);
    const rewards = journals(database).filter((journal) => journal.eventType === "customer_referral_reward");
    expect(rewards).toHaveLength(2);
    expect(rewards[0]?.metadata.cityKey).toBe("nellore");
  });

  it("holds referrals with fraud signals for an admin decision", async () => {
    const code = await ensureCustomerReferralCode("alice", "shared-phone-install", database);
    database.seed("users/bob", {phone: "9000000001", addresses: [{lat: 14.44, lng: 79.98, city: "Nellore"}]});
    const applied = await applyCustomerReferralCode("bob", {code, installId: "shared-phone-install"}, database);
    expect(applied.status).toBe("review");
    expect(applied.flags).toEqual(expect.arrayContaining(["sameDevice", "samePhone", "nearbyAddress"]));
    expect(await qualifyCustomerReferralOnDelivery(deliveredOrder("bob", "o1", 250), attribution, database)).toBe(false);
    await reviewCustomerReferralForAdmin("admin", owner, {referredUid: "bob", decision: "approved", reason: "Family, verified"}, database);
    expect(await qualifyCustomerReferralOnDelivery(deliveredOrder("bob", "o2", 250), attribution, database)).toBe(true);
  });

  it("refuses self-referral, existing customers and codes after the budget is spent", async () => {
    const code = await ensureCustomerReferralCode("alice", "install-a", database);
    await expect(applyCustomerReferralCode("alice", {code, installId: ""}, database)).rejects.toMatchObject({code: "failed-precondition"});
    database.seed("orders/old", {customerId: "carol", status: "Delivered"});
    database.seed("users/carol", {city: "Nellore"});
    await expect(applyCustomerReferralCode("carol", {code, installId: ""}, database)).rejects.toThrow(/not ordered yet/);

    await applyCustomerReferralCode("bob", {code, installId: "install-b"}, database);
    await qualifyCustomerReferralOnDelivery(deliveredOrder("bob", "o1", 250), attribution, database);
    database.seed("users/dave", {city: "Nellore"});
    await applyCustomerReferralCode("dave", {code, installId: "install-d"}, database);
    // The ₹100 budget was used by bob's referral, so dave's waits.
    expect(await qualifyCustomerReferralOnDelivery(deliveredOrder("dave", "o9", 250), attribution, database)).toBe(false);
    expect(database.read("customerWallets/dave")).toBeNull();
  });
});
