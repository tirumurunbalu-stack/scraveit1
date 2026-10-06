import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {buildPricing} from "../src/domain/order";
import {normalizeEconomicsControl, type EconomicsControl} from "../src/domain/economicsControl";
import {normalizePromotionTerms, settlementTerms} from "../src/domain/economics";
import {
  finalizeOrderEconomics,
  planCheckoutEconomics,
  promotionReservationRefs,
  releasePromotionSpend,
  reservePromotionSpend,
  resolveCheckoutPromotion,
  updateEconomicsControlForAdmin,
  type CheckoutPromotion,
  type ServerFees,
} from "../src/services/economics";
import {buildCodOrderDeliveryJournal, LEDGER_JOURNALS_COLLECTION, orderDeliveryAmounts} from "../src/services/ledger";
import {readFinanceStatement} from "../src/services/financeStatement";
import type {SavrivoOrder} from "../src/types";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const NOW = Date.UTC(2026, 9, 1, 14, 0);
const restaurant = {id: "r1", city: "Nellore"};
const address = {area: "Magunta Layout", label: "Home"};
const fees: ServerFees = {
  deliveryFee: 25, platformFee: 7, lateNightFee: 0, rainFee: 0, surgeFee: 0,
  riderIncentiveFee: 0, smallOrderThreshold: 0, smallOrderFee: 0,
};

function control(overrides: Record<string, unknown> = {}): EconomicsControl {
  return normalizeEconomicsControl({
    policies: {
      global: {
        minContributionPaisePerOrder: 800, targetContributionPaisePerOrder: 2_000,
        codHandlingCostPaise: 300, refundReserveBpsOfGmv: 0, supportCostPaisePerOrder: 200,
        otherVariableCostPaisePerOrder: 0,
      },
    },
    ...overrides,
  });
}

function promotion(fields: Record<string, unknown>, growthBudgetRemainingPaise = 0): CheckoutPromotion {
  return {terms: normalizePromotionTerms("promo1", {code: "NLR", active: true, ...fields}), growthBudgetRemainingPaise};
}

function plan(overrides: Partial<Parameters<typeof planCheckoutEconomics>[0]> = {}) {
  return planCheckoutEconomics({
    control: control(),
    restaurant,
    address,
    subtotal: 350,
    fees,
    paymentMethod: "cod",
    tip: 0,
    promotion: null,
    defaultCommissionBps: 1_000,
    now: NOW,
    ...overrides,
  });
}

function priceWith(checkout: ReturnType<typeof plan>, tip = 0) {
  const discount = (checkout.discount.restaurantDiscountPaise + checkout.discount.platformDiscountPaise) / 100;
  const {pricing, total} = buildPricing({
    subtotal: 350, discount, deliveryFee: fees.deliveryFee, platformFee: fees.platformFee, taxRate: 5, tip,
  });
  return {
    pricing: {...pricing, restaurantDiscount: checkout.discount.restaurantDiscountPaise / 100,
      platformDiscount: checkout.discount.platformDiscountPaise / 100},
    total,
  };
}

describe("checkout economics plan", () => {
  it("works a dish offer out on the offer's dishes only, not the whole cart", () => {
    const dishOffer = {...promotion({percent: 50, fundingSource: "restaurant", itemIds: ["w1"], restaurantIds: ["r1"]}),
      discountBasePaise: 12_000};
    const checkout = plan({promotion: dishOffer});
    // 50% of the ₹120 waffle, not of the ₹350 cart.
    expect(checkout.discount).toMatchObject({restaurantDiscountPaise: 6_000, platformDiscountPaise: 0});
  });

  it("gives a restaurant-funded offer in full and charges it to the restaurant", () => {
    const checkout = plan({promotion: promotion({percent: 20, maxDiscountPaise: 10_000, fundingSource: "restaurant"})});
    expect(checkout.discount).toMatchObject({restaurantDiscountPaise: 7_000, platformDiscountPaise: 0, withheldPlatformPaise: 0});
    const {pricing, total} = priceWith(checkout);
    const snapshot = finalizeOrderEconomics(checkout, pricing, total, "r1", "cod", []);
    expect(snapshot.restaurant.receivablePaise).toBe(25_200); // (350 - 70) * 90%
    expect(snapshot.customer.payablePaise).toBe(Math.round(total * 100));
  });

  it("caps a Scraveit-funded offer at what the order can safely give", () => {
    const checkout = plan({promotion: promotion({kind: "flat", flatAmountPaise: 10_000, fundingSource: "platform"})});
    // 37 contribution before promotion - 8 minimum = 29 safe.
    expect(checkout.discount).toMatchObject({platformDiscountPaise: 2_900, withheldPlatformPaise: 7_100, limitedBy: "profitability"});
    expect(checkout.offer).toMatchObject({code: "NLR", fundingSource: "platform", platformFundedPaise: 2_900});
    const {pricing, total} = priceWith(checkout);
    const snapshot = finalizeOrderEconomics(checkout, pricing, total, "r1", "cod", []);
    expect(snapshot.platform.contributionPaise).toBeGreaterThanOrEqual(snapshot.guardrail.minimumContributionPaise);
    expect(snapshot.restaurant.receivablePaise).toBe(31_500); // untouched by Scraveit's discount
  });

  it("pays the loss-making part only from a growth budget", () => {
    const checkout = plan({promotion: promotion(
      {kind: "flat", flatAmountPaise: 10_000, fundingSource: "platform", growthBudgetId: "launch"}, 4_000)});
    expect(checkout.discount).toMatchObject({platformDiscountPaise: 6_900, growthSubsidyPaise: 4_000});
    expect(checkout.offer?.growthBudgetId).toBe("launch");
  });

  it("splits a shared offer and keeps the restaurant share whole", () => {
    const checkout = plan({promotion: promotion({kind: "flat", flatAmountPaise: 5_000, fundingSource: "shared", restaurantShareBps: 6_000})});
    expect(checkout.discount).toMatchObject({restaurantDiscountPaise: 3_000, platformDiscountPaise: 2_000});
  });

  it("settles every discount the legacy restaurant-funded way when the engine is off", () => {
    const off = control({flags: {economicsEngine: false}});
    const checkout = plan({control: off, promotion: promotion({kind: "flat", flatAmountPaise: 5_000, fundingSource: "platform"})});
    expect(checkout.engineEnabled).toBe(false);
    expect(checkout.discount).toMatchObject({restaurantDiscountPaise: 5_000, platformDiscountPaise: 0});
  });

  it("only runs in the cities it is switched on for", () => {
    const guntur = control({flags: {enabledCityKeys: ["guntur"]}});
    expect(plan({control: guntur}).engineEnabled).toBe(false);
    expect(plan({control: control({flags: {enabledCityKeys: ["nellore"]}})}).engineEnabled).toBe(true);
  });

  it("uses the restaurant's founding-partner commission while it is in force", () => {
    const founding = control({commercialPlans: {r1: [{planId: "founding", label: "Founding", commissionBps: 800, effectiveFrom: NOW - 1, effectiveTo: 0}]}});
    const checkout = plan({control: founding});
    expect(checkout.commissionBps).toBe(800);
    const {pricing, total} = priceWith(checkout);
    const snapshot = finalizeOrderEconomics(checkout, pricing, total, "r1", "cod", []);
    expect(snapshot.restaurant.commissionPaise).toBe(2_800);
  });

  it("never pays a rider less than the minimum trip pay, even on free delivery", () => {
    const free = {...fees, deliveryFee: 0};
    const checkout = plan({fees: free});
    // Base ₹20 + 0.5 km expected pickup beyond the free km (₹2) = ₹22, lifted to the ₹25 minimum.
    expect(checkout.riderTripPayPaise).toBe(2_500);
    expect(checkout.tripPay).toMatchObject({minimumTopUpPaise: 300, totalPaise: 2_500});
    const {pricing, total} = buildPricing({subtotal: 350, discount: 0, deliveryFee: 0, platformFee: 7, taxRate: 0, tip: 0});
    const snapshot = finalizeOrderEconomics(checkout, pricing, total, "r1", "cod", []);
    expect(snapshot.platform.deliveryMarginPaise).toBe(-2_500);
    const amounts = orderDeliveryAmounts({total, pricing, economics: settlementTerms(snapshot)}, 1_500);
    expect(amounts.riderDeliveryEarningPaise).toBe(2_500);
    expect(amounts.riderTripSubsidyPaise).toBe(2_500);
  });
});

describe("delivery ledger from the frozen snapshot", () => {
  function deliveredOrder(checkout: ReturnType<typeof plan>, tip = 20): Pick<SavrivoOrder, "total" | "pricing" | "economics"> {
    const {pricing, total} = priceWith(checkout, tip);
    return {total, pricing, economics: settlementTerms(finalizeOrderEconomics(checkout, pricing, total, "r1", "cod", []))};
  }

  it("books a Scraveit-funded discount as a platform expense, never against the restaurant", async () => {
    const checkout = plan({promotion: promotion({kind: "flat", flatAmountPaise: 2_000, fundingSource: "platform"})});
    const order = deliveredOrder(checkout);
    // Commission is frozen at checkout: a later policy change to 25% is ignored.
    const amounts = orderDeliveryAmounts(order, 2_500);
    expect(amounts.restaurantPayablePaise).toBe(31_500);
    expect(amounts.platformCommissionPaise).toBe(3_500);
    expect(amounts.platformPromotionPaise).toBe(2_000);
    expect(amounts.riderTipPaise).toBe(2_000);
    const journal = buildCodOrderDeliveryJournal({...amounts, orderId: "SV-1", restaurantId: "r1", riderId: "rider1", occurredAt: NOW});
    expect(journal.debitTotalPaise).toBe(journal.creditTotalPaise);
    expect(journal.entries.find((entry) => entry.accountId === "expense:platform-promotions")?.amountPaise).toBe(2_000);

    // The finance statement's four buckets still add up to exactly what the customer paid.
    const database = new InMemoryFirestore();
    database.seed(`${LEDGER_JOURNALS_COLLECTION}/${journal.journalId}`, JSON.parse(JSON.stringify(journal)));
    const statement = await readFinanceStatement({savrivoRole: "owner"} as unknown as DecodedIdToken, {startAt: 0, endAt: NOW + 1}, database);
    const a = statement.allocation;
    expect(a.grossPaise).toBe(Math.round(order.total * 100));
    expect(a.restaurantPaise + a.riderPaise + a.platformPaise + a.taxPaise).toBe(a.grossPaise);
    expect(a.platformPaise).toBe(3_500 + 700 - 2_000);
  });

  it("refuses to settle a snapshot whose total no longer matches the order", () => {
    const checkout = plan();
    const order = deliveredOrder(checkout);
    expect(() => orderDeliveryAmounts({...order, total: order.total + 1}, 1_500)).toThrow("LEDGER_ECONOMICS_SNAPSHOT_TOTAL_MISMATCH");
  });

  it("keeps pre-engine orders settling exactly as before", () => {
    const legacy = orderDeliveryAmounts({
      total: 350 - 50 + 25 + 7,
      pricing: {subtotal: 350, discount: 50, deliveryFee: 25, platformFee: 7, tax: 0, tip: 0, smallOrderFee: 0,
        lateNightFee: 0, rainFee: 0, surgeFee: 0, riderIncentiveFee: 0, currency: "INR", source: "catalog_snapshot_v3"},
    }, 1_000);
    expect(legacy).toEqual({
      grossAmountPaise: 33_200, restaurantPayablePaise: 27_000, platformCommissionPaise: 3_000,
      platformFeePaise: 700, taxPayablePaise: 0, riderDeliveryEarningPaise: 2_500, riderTipPaise: 0,
    });
  });
});

describe("offer budgets and per-customer limits", () => {
  let database: InMemoryFirestore;

  beforeEach(() => {
    database = new InMemoryFirestore();
  });

  async function reserve(orderId: string, customerId: string, platformFundedPaise: number) {
    const terms = normalizePromotionTerms("promo1", database.read("promotions/promo1"));
    const offer = {
      promotionId: "promo1", code: terms.code, title: "", fundingSource: terms.fundingSource,
      restaurantFundedPaise: 0, platformFundedPaise, growthSubsidyPaise: 0, growthBudgetId: "",
      withheldPlatformPaise: 0, limitedBy: "" as const,
    };
    const refs = promotionReservationRefs(database, orderId, customerId, offer, terms)!;
    return database.runTransaction(async (transaction) => {
      const write = await reservePromotionSpend(transaction, refs, {orderId, customerId, offer, terms, cityKey: "nellore", at: NOW});
      write();
    });
  }

  it("never lets two customers spend the last of a budget twice", async () => {
    database.seed("promotions/promo1", {code: "NLR", active: true, fundingSource: "platform", budgetPaise: 3_000, usedBudgetPaise: 0});
    const results = await Promise.allSettled([reserve("A", "c1", 2_000), reserve("B", "c2", 2_000)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({reason: {code: "aborted"}});
    expect((database.read("promotions/promo1") as {usedBudgetPaise: number}).usedBudgetPaise).toBe(2_000);
  });

  it("enforces a one-per-customer offer and gives the use back on cancellation, exactly once", async () => {
    database.seed("promotions/promo1", {code: "NLR", active: true, fundingSource: "platform", budgetPaise: 10_000, perCustomerLimit: 1});
    await reserve("A", "c1", 1_000);
    await expect(reserve("B", "c1", 1_000)).rejects.toMatchObject({code: "failed-precondition"});
    await expect(resolveCheckoutPromotion("NLR", {subtotalPaise: 35_000, restaurantId: "r1", cityKey: "nellore", customerId: "c1", at: NOW}, database))
      .rejects.toMatchObject({code: "failed-precondition"});

    expect(await releasePromotionSpend("A", database)).toBe(true);
    expect(await releasePromotionSpend("A", database)).toBe(false);
    expect((database.read("promotions/promo1") as {usedBudgetPaise: number}).usedBudgetPaise).toBe(0);
    expect((database.read("promotionCustomerUsage/promo1_c1") as {count: number}).count).toBe(0);
    await expect(reserve("C", "c1", 1_000)).resolves.toBeUndefined();
  });

  it("stops offering a promotion whose budget is used up", async () => {
    database.seed("promotions/promo1", {code: "NLR", active: true, fundingSource: "platform", budgetPaise: 1_000, usedBudgetPaise: 1_000});
    await expect(resolveCheckoutPromotion("NLR", {subtotalPaise: 35_000, restaurantId: "r1", cityKey: "nellore", customerId: "c9", at: NOW}, database))
      .rejects.toThrow("fully claimed");
  });
});

describe("economics settings changes", () => {
  it("records who changed what, before and after, with a reason", async () => {
    const database = new InMemoryFirestore();
    const owner = {savrivoRole: "owner", email: "founder@scraveit.test"} as unknown as DecodedIdToken;
    await expect(updateEconomicsControlForAdmin("u1", owner, {
      update: {section: "policy", scopeType: "city", scopeKey: "Nellore", value: {minContributionPaisePerOrder: 1_000}},
      reason: "",
    }, database)).rejects.toMatchObject({code: "invalid-argument"});
    const result = await updateEconomicsControlForAdmin("u1", owner, {
      update: {section: "policy", scopeType: "city", scopeKey: "Nellore", value: {minContributionPaisePerOrder: 1_000}},
      reason: "Launch floor for Nellore",
      expectedRevision: 0,
    }, database);
    expect(result.control.revision).toBe(1);
    expect(result.control.policies.cities.nellore).toEqual({minContributionPaisePerOrder: 1_000});
    expect(database.read("economicsControlHistory/rev_00000001")).toMatchObject({
      target: "policy:city:nellore", before: {}, after: {minContributionPaisePerOrder: 1_000},
      reason: "Launch floor for Nellore", by: "u1", byEmail: "founder@scraveit.test",
    });
    await expect(updateEconomicsControlForAdmin("u1", owner, {
      update: {section: "flags", value: {profitabilityGuardrail: false}}, reason: "stale edit", expectedRevision: 0,
    }, database)).rejects.toMatchObject({code: "aborted"});
    await expect(updateEconomicsControlForAdmin("u2", {savrivoRole: "customer"} as unknown as DecodedIdToken, {
      update: {section: "flags", value: {}}, reason: "nope",
    }, database)).rejects.toMatchObject({code: "permission-denied"});
  });
});
