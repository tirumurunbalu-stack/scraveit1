import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {
  allocateRedemption,
  cashbackAward,
  maxRedeemableForOrder,
  normalizeCashbackCampaign,
  normalizeWalletLot,
  normalizeWalletRules,
} from "../src/domain/wallet";
import {computeOrderEconomics, normalizeEconomicsPolicy, settlementTerms} from "../src/domain/economics";
import {buildPricing} from "../src/domain/order";
import {clearEconomicsControlCache, orderEconomicsRecord} from "../src/services/economics";
import {
  buildCodOrderDeliveryJournal,
  LEDGER_JOURNALS_COLLECTION,
  orderDeliveryAmounts,
} from "../src/services/ledger";
import {
  earnCashbackForDeliveredOrder,
  expireWalletLots,
  planWalletRedemption,
  readCustomerWallet,
  reserveWalletRedemption,
  restoreWalletRedemption,
  reverseCashbackForOrder,
  upsertCashbackCampaignForAdmin,
} from "../src/services/wallet";
import {readFinanceStatement} from "../src/services/financeStatement";
import type {LedgerJournal} from "../src/domain/ledger";
import type {SavrivoOrder} from "../src/types";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1, 8, 0);
const owner = {savrivoRole: "owner"} as unknown as DecodedIdToken;
const policy = normalizeEconomicsPolicy({codHandlingCostPaise: 300, refundReserveBpsOfGmv: 0, supportCostPaisePerOrder: 200,
  otherVariableCostPaisePerOrder: 0, minContributionPaisePerOrder: 800, cashbackMaxShareOfContributionBps: 5_000});

describe("wallet rules", () => {
  it("limits how much wallet money one order may use", () => {
    const rules = normalizeWalletRules({maxRedeemBpsOfSubtotal: 2_000, maxRedeemPerOrderPaise: 5_000, minOrderForRedeemPaise: 15_000});
    expect(maxRedeemableForOrder(rules, 10_000)).toBe(0);
    expect(maxRedeemableForOrder(rules, 20_000)).toBe(4_000);
    expect(maxRedeemableForOrder(rules, 90_000)).toBe(5_000);
  });

  it("spends the earliest-expiring money first and never expired money", () => {
    const lots = [
      normalizeWalletLot("late", {remainingPaise: 3_000, expiresAt: NOW + 20 * DAY, createdAt: 1}),
      normalizeWalletLot("soon", {remainingPaise: 1_000, expiresAt: NOW + 2 * DAY, createdAt: 2}),
      normalizeWalletLot("gone", {remainingPaise: 9_000, expiresAt: NOW - 1, createdAt: 3}),
    ];
    expect(allocateRedemption(lots, 2_500, NOW).map((a) => [a.lotId, a.amountPaise])).toEqual([["soon", 1_000], ["late", 1_500]]);
  });

  it("caps contribution-funded cashback at the allowed share of the order's safe contribution", () => {
    const campaign = normalizeCashbackCampaign("c", {active: true, funding: "realized_contribution", kind: "flat",
      flatAmountPaise: 5_000, contributionShareBps: 2_000});
    const context = {subtotalPaise: 35_000, restaurantId: "r1", cityKey: "nellore", zoneKey: "z", orderedAt: NOW,
      safeContributionPaise: 2_500, policyContributionShareBps: 5_000, customerUses: 0, isFirstOrder: false};
    // ₹25 safe contribution × 20% = ₹5, never the ₹50 marketing asked for.
    expect(cashbackAward(campaign, context)?.amountPaise).toBe(500);
    expect(cashbackAward(campaign, {...context, safeContributionPaise: 0})).toBeNull();
  });

  it("refuses restaurant-funded cashback that does not name the restaurant", () => {
    const campaign = normalizeCashbackCampaign("c", {active: true, funding: "restaurant", kind: "percent", percent: 10});
    expect(cashbackAward(campaign, {subtotalPaise: 35_000, restaurantId: "r1", cityKey: "", zoneKey: "", orderedAt: NOW,
      safeContributionPaise: 0, policyContributionShareBps: 0, customerUses: 0, isFirstOrder: false})).toBeNull();
  });
});

describe("customer wallet service", () => {
  let database: InMemoryFirestore;

  beforeEach(() => {
    database = new InMemoryFirestore();
    clearEconomicsControlCache();
    database.seed("economicsControl/current", {
      policies: {global: {codHandlingCostPaise: 300, refundReserveBpsOfGmv: 0, supportCostPaisePerOrder: 200,
        otherVariableCostPaisePerOrder: 0, minContributionPaisePerOrder: 800, cashbackMaxShareOfContributionBps: 5_000}},
      walletRules: {maxEarnPerCustomerPerDayPaise: 10_000, maxRedeemBpsOfSubtotal: 2_000, maxRedeemPerOrderPaise: 10_000,
        minOrderForRedeemPaise: 10_000},
    });
  });

  function delivered(orderId: string, subtotalPaise = 35_000, customerId = "c1"): SavrivoOrder {
    const snapshot = computeOrderEconomics({
      cityKey: "nellore", zoneKey: "stonehousepet", restaurantId: "r1", paymentMethod: "cod", itemSubtotalPaise: subtotalPaise,
      restaurantDiscountPaise: 0, platformDiscountPaise: 0, deliveryFeePaise: 2_500, platformFeePaise: 700,
      smallOrderFeePaise: 0, lateNightFeePaise: 0, rainFeePaise: 0, surgeFeePaise: 0, riderIncentiveFeePaise: 0,
      taxPaise: 0, tipPaise: 0, commissionBps: 1_000, riderDeliveryPayPaise: 2_500, riderIncentivePayPaise: 0,
    }, policy);
    const pricing = buildPricing({subtotal: subtotalPaise / 100, discount: 0, deliveryFee: 25, platformFee: 7, taxRate: 0, tip: 0});
    const order = {
      id: orderId, customerId, restaurantId: "r1", riderId: "rd1", status: "Delivered", paymentState: "paid",
      createdAt: NOW, updatedAt: NOW, deliveredAt: NOW, total: pricing.total, pricing: pricing.pricing,
      economics: settlementTerms(snapshot),
    } as unknown as SavrivoOrder;
    database.seed(`orders/${orderId}`, order);
    database.seed(`orderEconomics/${orderId}`, orderEconomicsRecord(order, snapshot));
    return order;
  }

  const attribution = {cityKey: "nellore", zoneKey: "stonehousepet"};

  async function campaign(fields: Record<string, unknown>) {
    return upsertCashbackCampaignForAdmin("admin", owner, {campaignId: "cb1", title: "10% back", active: true,
      funding: "platform_budget", kind: "percent", percent: 10, maxCashbackPaise: 5_000, expiryDays: 30,
      reason: "launch", ...fields}, database);
  }

  function journals(): LedgerJournal[] {
    return database.paths().filter((path) => path.startsWith(`${LEDGER_JOURNALS_COLLECTION}/`))
      .map((path) => database.read(path) as LedgerJournal);
  }

  it("earns cashback once after delivery, books it as a Scraveit cost, and respects the budget", async () => {
    await campaign({budgetPaise: 5_000});
    const order = delivered("SV-1");
    expect(await earnCashbackForDeliveredOrder(order, attribution, database)).toMatchObject({status: "earned", amountPaise: 3_500});
    expect(await earnCashbackForDeliveredOrder(order, attribution, database)).toMatchObject({status: "already_earned"});
    expect((database.read("customerWallets/c1") as {balancePaise: number}).balancePaise).toBe(3_500);
    const journal = journals().find((entry) => entry.eventType === "cashback_earned")!;
    expect(journal.metadata).toMatchObject({cityKey: "nellore", campaignId: "cb1"});
    expect(journal.entries.find((entry) => entry.accountId === "expense:cashback")?.amountPaise).toBe(3_500);
    // Only ₹15 of the ₹50 budget is left for the next customer.
    expect(await earnCashbackForDeliveredOrder(delivered("SV-2", 35_000, "c2"), attribution, database))
      .toMatchObject({status: "earned", amountPaise: 1_500});
    expect(await earnCashbackForDeliveredOrder(delivered("SV-3", 35_000, "c3"), attribution, database))
      .toMatchObject({status: "none"});
  });

  it("charges restaurant-funded cashback to that restaurant's payable", async () => {
    await campaign({funding: "restaurant", restaurantIds: ["r1"]});
    await earnCashbackForDeliveredOrder(delivered("SV-1"), attribution, database);
    const journal = journals().find((entry) => entry.eventType === "cashback_earned")!;
    expect(journal.entries.find((entry) => entry.accountId === "liability:restaurant-payable:r1")).toMatchObject({side: "debit", amountPaise: 3_500});
    expect(journal.entries.some((entry) => entry.accountId === "expense:cashback")).toBe(false);
  });

  it("stops at the customer's daily earning cap", async () => {
    await campaign({maxCashbackPaise: 8_000});
    expect((await earnCashbackForDeliveredOrder(delivered("SV-1", 80_000), attribution, database)).amountPaise).toBe(8_000);
    expect((await earnCashbackForDeliveredOrder(delivered("SV-2", 80_000), attribution, database)).amountPaise).toBe(2_000);
    expect((await earnCashbackForDeliveredOrder(delivered("SV-3", 80_000), attribution, database)).status).toBe("none");
  });

  it("does not reward a customer blocked by a fraud flag", async () => {
    await campaign({});
    database.seed("customerRisk/c1", {blockRewards: true, reason: "farming"});
    expect((await earnCashbackForDeliveredOrder(delivered("SV-1"), attribution, database)).status).toBe("blocked");
  });

  it("redeems at checkout, restores on cancellation exactly once", async () => {
    await campaign({});
    await earnCashbackForDeliveredOrder(delivered("SV-1"), attribution, database);
    const rules = normalizeWalletRules({maxRedeemBpsOfSubtotal: 2_000, maxRedeemPerOrderPaise: 10_000, minOrderForRedeemPaise: 10_000});
    const plan = await planWalletRedemption({customerId: "c1", rules, subtotalPaise: 20_000, payableBeforeWalletPaise: 23_200,
      at: NOW, requested: true}, database);
    expect(plan).toMatchObject({balancePaise: 3_500, maxForOrderPaise: 4_000, amountPaise: 3_500});
    await database.runTransaction(async (transaction) => {
      const write = await reserveWalletRedemption(transaction, {customerId: "c1", orderId: "SV-9", amountPaise: 3_500, at: NOW}, database);
      write();
    });
    expect((database.read("customerWallets/c1") as {balancePaise: number}).balancePaise).toBe(0);
    // A second order racing for the same money is refused rather than under-paid.
    await expect(database.runTransaction(async (transaction) => {
      await reserveWalletRedemption(transaction, {customerId: "c1", orderId: "SV-10", amountPaise: 100, at: NOW}, database);
    })).rejects.toMatchObject({code: "aborted"});
    expect(await restoreWalletRedemption("SV-9", database)).toBe(3_500);
    expect(await restoreWalletRedemption("SV-9", database)).toBe(0);
    expect((database.read("customerWallets/c1") as {balancePaise: number}).balancePaise).toBe(3_500);
  });

  it("reverses unspent cashback after a refund, and records what could not be recovered", async () => {
    await campaign({});
    const order = delivered("SV-1");
    await earnCashbackForDeliveredOrder(order, attribution, database);
    database.seed("walletLots/cb_SV-1", {...database.read("walletLots/cb_SV-1") as object, remainingPaise: 1_000});
    expect(await reverseCashbackForOrder(order, "refund", attribution, database)).toEqual({recoveredPaise: 1_000, unrecoveredPaise: 2_500});
    expect(await reverseCashbackForOrder(order, "refund", attribution, database)).toEqual({recoveredPaise: 0, unrecoveredPaise: 0});
    const reversal = journals().find((entry) => entry.eventType === "cashback_reversed")!;
    expect(reversal.entries.find((entry) => entry.accountId === "expense:cashback")).toMatchObject({side: "credit", amountPaise: 1_000});
  });

  it("expires unspent money, returns restaurant-funded money to the restaurant, and keeps the statement balanced", async () => {
    await campaign({funding: "shared", restaurantIds: ["r1"], restaurantShareBps: 4_000, expiryDays: 1});
    await earnCashbackForDeliveredOrder(delivered("SV-1"), attribution, database);
    expect(await expireWalletLots(NOW + 2 * DAY, database)).toEqual({expiredLots: 1, expiredPaise: 3_500});
    expect(await expireWalletLots(NOW + 3 * DAY, database)).toEqual({expiredLots: 0, expiredPaise: 0});
    const expiry = journals().find((entry) => entry.eventType === "wallet_expired")!;
    expect(expiry.entries.find((entry) => entry.accountId === "liability:restaurant-payable:r1")?.amountPaise).toBe(1_400);
    expect(expiry.entries.find((entry) => entry.accountId === "revenue:wallet-breakage")?.amountPaise).toBe(2_100);
    const statement = await readFinanceStatement(owner, {startAt: 0, endAt: NOW + 10 * DAY}, database);
    const a = statement.allocation;
    expect(a.restaurantPaise + a.riderPaise + a.platformPaise + a.taxPaise + a.customerWalletPaise).toBe(a.grossPaise);
    expect(a.customerWalletPaise).toBe(0);
  });

  it("books wallet money spent on an order as part of what the customer paid", async () => {
    const snapshot = computeOrderEconomics({
      cityKey: "nellore", zoneKey: "z", restaurantId: "r1", paymentMethod: "cod", itemSubtotalPaise: 35_000,
      restaurantDiscountPaise: 0, platformDiscountPaise: 0, deliveryFeePaise: 2_500, platformFeePaise: 700,
      smallOrderFeePaise: 0, lateNightFeePaise: 0, rainFeePaise: 0, surgeFeePaise: 0, riderIncentiveFeePaise: 0,
      taxPaise: 0, tipPaise: 0, commissionBps: 1_000, riderDeliveryPayPaise: 2_500, riderIncentivePayPaise: 0,
      walletRedeemPaise: 3_000,
    }, policy);
    const pricing = buildPricing({subtotal: 350, discount: 0, deliveryFee: 25, platformFee: 7, taxRate: 0, tip: 0, walletRedeem: 30});
    expect(snapshot.customer.payablePaise).toBe(Math.round(pricing.total * 100));
    const amounts = orderDeliveryAmounts({...pricing, economics: settlementTerms(snapshot)}, 1_500);
    const journal = buildCodOrderDeliveryJournal({...amounts, orderId: "SV-W", restaurantId: "r1", riderId: "rd1",
      customerId: "c1", occurredAt: NOW});
    expect(journal.entries.find((entry) => entry.accountId === "liability:customer-wallet:c1")).toMatchObject({side: "debit", amountPaise: 3_000});
    // The restaurant is still owed its full share.
    expect(amounts.restaurantPayablePaise).toBe(31_500);
  });

  it("shows the customer their balance, expiring money and live cashback offers", async () => {
    await campaign({});
    await earnCashbackForDeliveredOrder(delivered("SV-1"), attribution, database);
    const wallet = await readCustomerWallet("c1", database);
    expect(wallet.balancePaise).toBe(3_500);
    expect(wallet.lots[0]).toMatchObject({remainingPaise: 3_500, source: "cashback"});
    expect(wallet.cashbackCampaigns[0]).toMatchObject({title: "10% back", funding: "scraveit"});
  });
});
