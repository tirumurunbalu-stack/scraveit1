import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));
vi.mock("../src/services/platformConfig", () => ({
  loadFinancePolicy: vi.fn(async () => ({restaurantCommissionBps: 1_000})),
}));

import {computeOrderEconomics, normalizeEconomicsPolicy, type OrderEconomicsInput} from "../src/domain/economics";
import {createLedgerJournal} from "../src/domain/ledger";
import {clearEconomicsControlCache} from "../src/services/economics";
import {
  listRestaurantOffers,
  readCityEconomics,
  reviewRestaurantOfferForAdmin,
  simulateGuarantee,
  summarizeCityEconomics,
  upsertGrowthBudgetForAdmin,
  upsertPromotionForAdmin,
  upsertRestaurantOffer,
  type PromotionUpsertRequest,
} from "../src/services/economicsAdmin";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const owner = {savrivoRole: "owner", email: "founder@scraveit.test"} as unknown as DecodedIdToken;
const opsAdmin = {savrivoRole: "ops_admin"} as unknown as DecodedIdToken;
const nobody = {} as unknown as DecodedIdToken;

const policy = normalizeEconomicsPolicy({
  minContributionPaisePerOrder: 800, targetContributionPaisePerOrder: 2_000, codHandlingCostPaise: 300,
  refundReserveBpsOfGmv: 0, supportCostPaisePerOrder: 200, otherVariableCostPaisePerOrder: 0,
});

function order(overrides: Partial<OrderEconomicsInput> = {}) {
  return computeOrderEconomics({
    cityKey: "nellore", zoneKey: "stonehousepet", restaurantId: "r1", paymentMethod: "cod",
    itemSubtotalPaise: 35_000, restaurantDiscountPaise: 0, platformDiscountPaise: 0,
    deliveryFeePaise: 2_500, platformFeePaise: 700, smallOrderFeePaise: 0, lateNightFeePaise: 0,
    rainFeePaise: 0, surgeFeePaise: 0, riderIncentiveFeePaise: 0, taxPaise: 0, tipPaise: 0,
    commissionBps: 1_000, riderDeliveryPayPaise: 2_500, riderIncentivePayPaise: 0,
    ...overrides,
  }, policy);
}

const sample = {
  averageOrderValuePaise: 35_000, deliveryFeePaise: 2_500, platformFeePaise: 700, riderPayPerOrderPaise: 2_500,
  onlinePaymentShareBps: 0, expectedOrders: 1_000, redemptionShareBps: 5_000,
};

function promotionRequest(overrides: Partial<PromotionUpsertRequest> = {}): PromotionUpsertRequest {
  return {
    code: "NELLORE100", title: "Rs 100 off", description: "", kind: "flat", percent: 0, flatAmountPaise: 10_000,
    maxDiscountPaise: 0, minimumOrderPaise: 0, fundingSource: "platform", restaurantShareBps: 0,
    restaurantIds: [], cityKeys: ["nellore"], firstOrderOnly: false, perCustomerLimit: 1, budgetPaise: 500_000,
    growthBudgetId: "", startsAt: 0, expiresAt: 0, active: true, acknowledgeLimitedFunding: false,
    simulation: sample, ...overrides,
  };
}

let database: InMemoryFirestore;

beforeEach(() => {
  database = new InMemoryFirestore();
  clearEconomicsControlCache();
  database.seed("economicsControl/current", {policies: {global: {
    minContributionPaisePerOrder: 800, targetContributionPaisePerOrder: 2_000, codHandlingCostPaise: 300,
    refundReserveBpsOfGmv: 0, supportCostPaisePerOrder: 200, otherVariableCostPaisePerOrder: 0,
  }}});
});

describe("admin offer publishing", () => {
  it("refuses to silently activate a loss-making Rs 100 Scraveit-funded offer", async () => {
    await expect(upsertPromotionForAdmin("u1", owner, promotionRequest(), database))
      .rejects.toThrow(/Unsafe: Scraveit would fund ₹100 per order but can safely fund at most ₹29/);
  });

  it("publishes it once the admin accepts that customers only get the safe amount", async () => {
    const result = await upsertPromotionForAdmin("u1", owner, promotionRequest({acknowledgeLimitedFunding: true}), database);
    expect(result.simulation.verdict).toBe("unsafe");
    expect(result.promotion).toMatchObject({code: "NELLORE100", fundingSource: "platform", restaurantShareBps: 0, active: true});
    const audit = database.paths().filter((path) => path.startsWith("audit/promotion_"));
    expect(audit).toHaveLength(1);
  });

  it("will not spend a restaurant's money on an offer that does not name it", async () => {
    await expect(upsertPromotionForAdmin("u1", owner, promotionRequest({fundingSource: "restaurant", restaurantIds: []}), database))
      .rejects.toThrow(/must name the restaurants/);
  });

  it("rejects a duplicate active code and non-admins", async () => {
    await upsertPromotionForAdmin("u1", owner, promotionRequest({flatAmountPaise: 1_000}), database);
    await expect(upsertPromotionForAdmin("u1", owner, promotionRequest({flatAmountPaise: 1_000}), database))
      .rejects.toMatchObject({code: "already-exists"});
    await expect(upsertPromotionForAdmin("u2", nobody, promotionRequest(), database)).rejects.toMatchObject({code: "permission-denied"});
  });
});

describe("growth budgets", () => {
  it("can only be approved by the owner, with a reason, and never below what is already spent", async () => {
    const input = {name: "Nellore launch week", cityKey: "Nellore", approvedPaise: 2_000_000, validFrom: 0, validUntil: 0, active: true, reason: "Launch"};
    await expect(upsertGrowthBudgetForAdmin("u2", opsAdmin, input, database)).rejects.toMatchObject({code: "permission-denied"});
    const budget = await upsertGrowthBudgetForAdmin("u1", owner, input, database);
    expect(budget).toMatchObject({cityKey: "nellore", approvedPaise: 2_000_000, spentPaise: 0, active: true});
    database.seed(`growthBudgets/${budget.id}`, {...database.read(`growthBudgets/${budget.id}`) as object, spentPaise: 1_500_000});
    await expect(upsertGrowthBudgetForAdmin("u1", owner, {...input, budgetId: budget.id, approvedPaise: 1_000_000}, database))
      .rejects.toThrow(/already spent/);
  });
});

describe("restaurant-created offers", () => {
  beforeEach(() => {
    database.seed("restaurants/r1", {id: "r1", city: "Nellore"});
    database.seed("restaurantMembers/r1_owner1", {active: true, role: "restaurant_owner", restaurantId: "r1"});
    database.seed("restaurantMembers/r1_cook1", {active: true, role: "staff", restaurantId: "r1", permissions: {orders: true}});
  });

  const offer = {
    restaurantId: "r1", code: "WAFFLE20", title: "20% off waffles", kind: "percent" as const, percent: 20,
    flatAmountPaise: 0, maxDiscountPaise: 8_000, minimumOrderPaise: 19_900, perCustomerLimit: 0,
    startsAt: 0, expiresAt: 0, active: true,
  };

  it("is always funded by the restaurant itself and auto-approved inside the limits", async () => {
    const result = await upsertRestaurantOffer("owner1", {} as DecodedIdToken, offer, database);
    expect(result.promotion).toMatchObject({fundingSource: "restaurant", restaurantIds: ["r1"], cityKeys: ["nellore"],
      approvalStatus: "approved", createdByRestaurantId: "r1"});
    expect(result.youFundPaiseOnSample).toBe(6_000);
    const listed = await listRestaurantOffers("owner1", {} as DecodedIdToken, "r1", database);
    expect(listed.offers).toHaveLength(1);
  });

  it("waits for admin approval when it is bigger than the auto-approval limit", async () => {
    const result = await upsertRestaurantOffer("owner1", {} as DecodedIdToken, {...offer, code: "HALF", percent: 50, maxDiscountPaise: 30_000}, database);
    expect(result.approvalStatus).toBe("pending");
    await reviewRestaurantOfferForAdmin("admin1", owner, {promotionId: String(result.promotion.id), decision: "approved", reason: "Checked with owner"}, database);
    expect(database.read(`promotions/${result.promotion.id}`)).toMatchObject({approvalStatus: "approved", reviewedBy: "admin1"});
  });

  it("is off limits to kitchen staff without offer permission and to other restaurants", async () => {
    await expect(upsertRestaurantOffer("cook1", {} as DecodedIdToken, offer, database)).rejects.toMatchObject({code: "permission-denied"});
    database.seed("restaurantMembers/r2_owner2", {active: true, role: "restaurant_owner", restaurantId: "r2"});
    await expect(upsertRestaurantOffer("owner2", {} as DecodedIdToken, offer, database)).rejects.toMatchObject({code: "permission-denied"});
  });
});

describe("guarantee simulation", () => {
  it("shows expected and worst-case liability against what the covered orders earn", () => {
    const result = simulateGuarantee({
      tiers: [{target: 21, guaranteedPaise: 168_000}], maxRiders: 20, expectedRiders: 12,
      minimumEarningPerDeliveryPaise: 2_500, expectedEarningPerDeliveryPaise: 6_500, budgetPaise: 0,
      expectedOrders: 250, contributionPerOrderPaise: 2_000,
    });
    // Expected: 21 * 65 = 1,365 -> 315 per rider * 12 = 3,780. Worst: 21 * 25 = 525 -> 1,155 * 20 = 23,100.
    expect(result.expectedPaise).toBe(378_000);
    expect(result.worstCasePaise).toBe(2_310_000);
    expect(result.expectedOrderContributionPaise).toBe(500_000);
    expect(result.verdict).toBe("below_target");
  });
});

describe("city economics dashboard", () => {
  it("adds up revenue, costs, contribution, reserves and the north-star metric", () => {
    const records = [
      {customerId: "c1", outcome: "delivered", createdAt: 1, snapshot: order()},
      {customerId: "c1", outcome: "delivered", createdAt: 2, snapshot: order({platformDiscountPaise: 1_000})},
      {customerId: "c2", outcome: "delivered", createdAt: 3, snapshot: order({zoneKey: "magunta", restaurantDiscountPaise: 5_000})},
      {customerId: "c3", outcome: "cancelled", createdAt: 4, snapshot: order()},
      {customerId: "c4", outcome: "open", createdAt: 5, snapshot: order()},
    ];
    const guarantee = createLedgerJournal({
      eventType: "rider_incentive", eventId: "g1", occurredAt: 10,
      metadata: {payoutMode: "earnings_guarantee", settlementType: "period_close", campaignId: "dinner", cityKey: "nellore"},
      postings: [
        {accountId: "expense:rider-guarantee-topups", side: "debit", amountPaise: 3_000},
        {accountId: "liability:rider-earnings:r1", side: "credit", amountPaise: 3_000},
      ],
    });
    const legacyBonus = createLedgerJournal({
      eventType: "rider_incentive", eventId: "old1", occurredAt: 11,
      metadata: {settlementType: "period_close", campaignId: "old"},
      postings: [
        {accountId: "expense:rider-rewards:daily_incentive", side: "debit", amountPaise: 1_000},
        {accountId: "liability:rider-earnings:r9", side: "credit", amountPaise: 1_000},
      ],
    });
    const gunturBonus = createLedgerJournal({
      eventType: "rider_incentive", eventId: "g2", occurredAt: 12,
      metadata: {settlementType: "period_close", campaignId: "gnt", cityKey: "guntur"},
      postings: [
        {accountId: "expense:rider-rewards:daily_incentive", side: "debit", amountPaise: 7_000},
        {accountId: "liability:rider-earnings:r8", side: "credit", amountPaise: 7_000},
      ],
    });
    const summary = summarizeCityEconomics({cityKey: "nellore", startAt: 0, endAt: 86_400_000, records,
      journals: [guarantee, legacyBonus, gunturBonus], policy, truncated: false});
    // Another city's rider costs never land in Nellore; entries written before
    // attribution existed are shown separately, not guessed into a city.
    expect(summary.costs.riderMilestoneBonusPaise).toBe(0);
    expect(summary.unattributedCostPaise).toBe(1_000);
    expect(summary.orders).toEqual({placed: 5, delivered: 3, cancelled: 1, open: 1});
    // 3,700 + 2,700 (Rs 10 Scraveit discount) + 3,200 (restaurant discount costs Scraveit Rs 5 commission).
    expect(summary.operatingContributionPaise).toBe(3_700 + 2_700 + 3_200);
    expect(summary.costs.guaranteeTopUpPaise).toBe(3_000);
    expect(summary.netContributionPaise).toBe(9_600 - 3_000);
    expect(summary.costs.platformDiscountPaise).toBe(1_000);
    expect(summary.restaurantFundedDiscountPaise).toBe(5_000);
    expect(summary.repeatOrders).toBe(1);
    expect(summary.contributionPositiveRepeatOrders).toBe(1);
    expect(summary.activeZones).toBe(2);
    expect(summary.northStar).toBe(0.5);
    const r = summary.reserves;
    expect(r.operatingReservePaise + r.expansionReservePaise + r.riskReservePaise + r.distributablePaise).toBe(summary.netCashImpactPaise);
  });

  it("reads only the chosen city and period, admin only", async () => {
    database.seed("orderEconomics/A", {orderId: "A", customerId: "c1", cityKey: "nellore", createdAt: 100, outcome: "delivered", snapshot: order()});
    database.seed("orderEconomics/B", {orderId: "B", customerId: "c2", cityKey: "guntur", createdAt: 100, outcome: "delivered", snapshot: order({cityKey: "guntur"})});
    database.seed("orderEconomics/C", {orderId: "C", customerId: "c3", cityKey: "nellore", createdAt: 999_999, outcome: "delivered", snapshot: order()});
    const summary = await readCityEconomics(owner, {cityKey: "Nellore", startAt: 0, endAt: 1_000}, database);
    expect(summary.orders.delivered).toBe(1);
    await expect(readCityEconomics(nobody, {cityKey: "", startAt: 0, endAt: 1_000}, database)).rejects.toMatchObject({code: "permission-denied"});
  });
});
