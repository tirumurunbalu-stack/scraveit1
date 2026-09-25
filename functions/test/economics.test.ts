import {describe, expect, it} from "vitest";
import {
  DEFAULT_ECONOMICS_POLICY,
  activeCommercialPlan,
  allocateReserves,
  computeOrderEconomics,
  economicsImbalancePaise,
  guardPlatformDiscount,
  normalizeCommercialPlans,
  normalizeEconomicsPolicy,
  normalizePromotionTerms,
  promotionDiscountPaise,
  promotionIneligibility,
  resolveEconomicsPolicy,
  simulateOffer,
  splitDiscountByFunding,
  type EconomicsPolicy,
  type OrderEconomicsInput,
} from "../src/domain/economics";

/** A plain Nellore dinner order: Rs 350 of food, Rs 25 delivery, Rs 7 platform fee, 10% commission. */
function baseOrder(overrides: Partial<OrderEconomicsInput> = {}): OrderEconomicsInput {
  return {
    cityKey: "nellore",
    zoneKey: "magunta-layout",
    restaurantId: "r1",
    paymentMethod: "cod",
    itemSubtotalPaise: 35_000,
    restaurantDiscountPaise: 0,
    platformDiscountPaise: 0,
    deliveryFeePaise: 2_500,
    platformFeePaise: 700,
    smallOrderFeePaise: 0,
    lateNightFeePaise: 0,
    rainFeePaise: 0,
    surgeFeePaise: 0,
    riderIncentiveFeePaise: 0,
    taxPaise: 0,
    tipPaise: 0,
    commissionBps: 1_000,
    riderDeliveryPayPaise: 2_500,
    riderIncentivePayPaise: 0,
    ...overrides,
  };
}

/** Costs kept round so the worked examples in the docs stay checkable by hand. */
const policy: EconomicsPolicy = normalizeEconomicsPolicy({
  minContributionPaisePerOrder: 800,
  targetContributionPaisePerOrder: 2_000,
  paymentGatewayCostBps: 200,
  codHandlingCostPaise: 300,
  refundReserveBpsOfGmv: 0,
  supportCostPaisePerOrder: 200,
  otherVariableCostPaisePerOrder: 0,
  operatingReserveBps: 4_000,
  expansionReserveBps: 3_000,
  riskReserveBps: 1_000,
  maxPlatformSubsidyPerOrderPaise: 10_000,
});

describe("order economics", () => {
  it("computes a normal profitable order and keeps tips and tax out of revenue", () => {
    const snapshot = computeOrderEconomics(baseOrder({tipPaise: 2_000, taxPaise: 1_750}), policy);
    // Commission 10% of 350 = 35; fees 25 + 7; rider takes the 25 delivery pay.
    expect(snapshot.restaurant.commissionPaise).toBe(3_500);
    expect(snapshot.restaurant.receivablePaise).toBe(31_500);
    expect(snapshot.platform.grossRevenuePaise).toBe(3_500 + 2_500 + 700);
    expect(snapshot.rider.totalPaise).toBe(2_500 + 2_000);
    // 67 revenue - 25 rider - 3 COD handling - 2 support = 37.
    expect(snapshot.platform.contributionPaise).toBe(3_700);
    expect(snapshot.guardrail.verdict).toBe("safe");
    expect(economicsImbalancePaise(snapshot)).toBe(0);
  });

  it("charges a restaurant-funded discount to the restaurant, not Scraveit", () => {
    const plain = computeOrderEconomics(baseOrder(), policy);
    const discounted = computeOrderEconomics(baseOrder({restaurantDiscountPaise: 5_000}), policy);
    expect(discounted.restaurant.receivablePaise).toBe(27_000); // (350-50) * 90%
    expect(discounted.platform.promotionCostPaise).toBe(0);
    // Scraveit only gives up its commission on the Rs 50 it never received.
    expect(plain.platform.contributionPaise - discounted.platform.contributionPaise).toBe(500);
    expect(economicsImbalancePaise(discounted)).toBe(0);
  });

  it("charges a platform-funded discount to Scraveit and never to the restaurant", () => {
    const plain = computeOrderEconomics(baseOrder(), policy);
    const discounted = computeOrderEconomics(baseOrder({platformDiscountPaise: 1_500}), policy);
    expect(discounted.restaurant.receivablePaise).toBe(plain.restaurant.receivablePaise);
    expect(discounted.platform.contributionPaise).toBe(plain.platform.contributionPaise - 1_500);
    expect(discounted.customer.payablePaise).toBe(plain.customer.payablePaise - 1_500);
    expect(economicsImbalancePaise(discounted)).toBe(0);
  });

  it("splits a shared discount by the stored ratio", () => {
    expect(splitDiscountByFunding({fundingSource: "shared", restaurantShareBps: 8_000}, 5_000))
      .toEqual({restaurantPaise: 4_000, platformPaise: 1_000});
    expect(splitDiscountByFunding({fundingSource: "platform", restaurantShareBps: 8_000}, 5_000))
      .toEqual({restaurantPaise: 0, platformPaise: 5_000});
    expect(splitDiscountByFunding({fundingSource: "restaurant", restaurantShareBps: 0}, 5_000))
      .toEqual({restaurantPaise: 5_000, platformPaise: 0});
  });

  it("treats free delivery as a Scraveit cost when the rider is still paid", () => {
    const free = computeOrderEconomics(baseOrder({deliveryFeePaise: 0, riderDeliveryPayPaise: 2_500}), policy);
    expect(free.platform.contributionPaise).toBe(3_700 - 2_500);
    expect(free.rider.deliveryPayPaise).toBe(2_500);
  });

  it("accounts for rain on both sides separately", () => {
    // Customer pays Rs 20 rain fee; rider receives Rs 25 rain incentive: Scraveit is Rs 5 worse off.
    const plain = computeOrderEconomics(baseOrder(), policy);
    const rain = computeOrderEconomics(baseOrder({rainFeePaise: 2_000, riderIncentivePayPaise: 2_500}), policy);
    expect(rain.platform.contributionPaise - plain.platform.contributionPaise).toBe(-500);
    const profitableRain = computeOrderEconomics(baseOrder({rainFeePaise: 3_000, riderIncentivePayPaise: 2_000}), policy);
    expect(profitableRain.platform.contributionPaise - plain.platform.contributionPaise).toBe(1_000);
  });

  it("uses gateway cost for online orders and handling cost for cash", () => {
    const upi = computeOrderEconomics(baseOrder({paymentMethod: "upi"}), policy);
    expect(upi.platform.paymentCostPaise).toBe(Math.round(upi.customer.payablePaise * 0.02));
    const cod = computeOrderEconomics(baseOrder(), policy);
    expect(cod.platform.paymentCostPaise).toBe(300);
  });

  it("refuses a discount larger than the food itself", () => {
    expect(() => computeOrderEconomics(baseOrder({restaurantDiscountPaise: 30_000, platformDiscountPaise: 6_000}), policy))
      .toThrow("ECONOMICS_DISCOUNT_EXCEEDS_SUBTOTAL");
  });

  it("reconciles every rupee across a wide grid of orders", () => {
    const methods = ["cod", "upi", "card"] as const;
    for (let subtotal = 5_000; subtotal <= 150_000; subtotal += 7_300) {
      for (const method of methods) {
        for (const shareBps of [0, 3_333, 10_000]) {
          const discount = Math.floor(subtotal * 0.37);
          const split = splitDiscountByFunding({fundingSource: "shared", restaurantShareBps: shareBps}, discount);
          const snapshot = computeOrderEconomics(baseOrder({
            paymentMethod: method,
            itemSubtotalPaise: subtotal,
            restaurantDiscountPaise: split.restaurantPaise,
            platformDiscountPaise: split.platformPaise,
            rainFeePaise: 1_900,
            surgeFeePaise: 900,
            lateNightFeePaise: 1_900,
            taxPaise: Math.round(subtotal * 0.05),
            tipPaise: 1_000,
            commissionBps: 1_234,
          }), policy);
          expect(economicsImbalancePaise(snapshot)).toBe(0);
          expect(snapshot.restaurant.receivablePaise).toBeGreaterThanOrEqual(0);
          expect(snapshot.rider.totalPaise).toBeGreaterThanOrEqual(0);
          const reserves = snapshot.platform;
          if (reserves.contributionPaise > 0) {
            expect(reserves.operatingReservePaise + reserves.expansionReservePaise + reserves.riskReservePaise +
              reserves.distributablePaise).toBe(reserves.contributionPaise);
          }
        }
      }
    }
  });
});

describe("profitability guardrail", () => {
  it("lets a platform discount through when it stays within the safe limit", () => {
    const snapshot = computeOrderEconomics(baseOrder(), policy);
    // 37 contribution before promotion - 8 minimum = 29 capacity.
    expect(snapshot.guardrail.promotionCapacityPaise).toBe(2_900);
    const guarded = guardPlatformDiscount({
      requestedRestaurantPaise: 0,
      requestedPlatformPaise: 1_500,
      promotionCapacityPaise: snapshot.guardrail.promotionCapacityPaise,
      guardrailEnabled: true,
      promotionBudgetRemainingPaise: null,
      growthBudgetRemainingPaise: 0,
    });
    expect(guarded).toMatchObject({platformDiscountPaise: 1_500, withheldPlatformPaise: 0, limitedBy: ""});
  });

  it("withholds the unsafe part of a platform discount instead of making the order lose money", () => {
    // Capacity is measured after the restaurant's own share, which already
    // lowers Scraveit's commission (Rs 20 off the base = Rs 2 less commission).
    const afterRestaurantShare = computeOrderEconomics(baseOrder({restaurantDiscountPaise: 2_000}), policy);
    expect(afterRestaurantShare.guardrail.promotionCapacityPaise).toBe(2_700);
    const guarded = guardPlatformDiscount({
      requestedRestaurantPaise: 2_000,
      requestedPlatformPaise: 10_000,
      promotionCapacityPaise: afterRestaurantShare.guardrail.promotionCapacityPaise,
      guardrailEnabled: true,
      promotionBudgetRemainingPaise: null,
      growthBudgetRemainingPaise: 0,
    });
    expect(guarded).toEqual({
      restaurantDiscountPaise: 2_000,
      platformDiscountPaise: 2_700,
      growthSubsidyPaise: 0,
      withheldPlatformPaise: 7_300,
      limitedBy: "profitability",
    });
    const snapshot = computeOrderEconomics(baseOrder({
      restaurantDiscountPaise: guarded.restaurantDiscountPaise,
      platformDiscountPaise: guarded.platformDiscountPaise,
    }), policy);
    expect(snapshot.platform.contributionPaise).toBe(snapshot.guardrail.minimumContributionPaise);
    expect(snapshot.guardrail.verdict).not.toBe("unsafe");
  });

  it("lets everything through when the guardrail is switched off, but still honours the budget", () => {
    const guarded = guardPlatformDiscount({
      requestedRestaurantPaise: 0,
      requestedPlatformPaise: 10_000,
      promotionCapacityPaise: 2_900,
      guardrailEnabled: false,
      promotionBudgetRemainingPaise: 6_000,
      growthBudgetRemainingPaise: 0,
    });
    expect(guarded).toMatchObject({platformDiscountPaise: 6_000, withheldPlatformPaise: 4_000, limitedBy: "promotion_budget"});
  });

  it("pays beyond the safe limit only from an approved growth budget, and reports it separately", () => {
    const guarded = guardPlatformDiscount({
      requestedRestaurantPaise: 0,
      requestedPlatformPaise: 10_000,
      promotionCapacityPaise: 2_900,
      guardrailEnabled: true,
      promotionBudgetRemainingPaise: null,
      growthBudgetRemainingPaise: 5_000,
    });
    expect(guarded).toMatchObject({platformDiscountPaise: 7_900, growthSubsidyPaise: 5_000, withheldPlatformPaise: 2_100});
    const snapshot = computeOrderEconomics(baseOrder({
      platformDiscountPaise: guarded.platformDiscountPaise,
      growthSubsidyPaise: guarded.growthSubsidyPaise,
    }), policy);
    expect(snapshot.platform.growthSubsidyPaise).toBe(5_000);
    expect(snapshot.platform.operatingContributionPaise).toBe(snapshot.platform.contributionPaise + 5_000);
    // The order's own operating result still meets the minimum; the loss is the growth budget's.
    expect(snapshot.guardrail.verdict).not.toBe("unsafe");
  });

  it("never spends more than the promotion's own remaining budget", () => {
    const guarded = guardPlatformDiscount({
      requestedRestaurantPaise: 0,
      requestedPlatformPaise: 2_000,
      promotionCapacityPaise: 2_900,
      guardrailEnabled: true,
      promotionBudgetRemainingPaise: 500,
      growthBudgetRemainingPaise: 0,
    });
    expect(guarded).toMatchObject({platformDiscountPaise: 500, limitedBy: "promotion_budget"});
  });

  it("caps any one order's subsidy at the policy maximum", () => {
    const rich = computeOrderEconomics(baseOrder({itemSubtotalPaise: 900_000}), normalizeEconomicsPolicy({
      ...policy,
      maxPlatformSubsidyPerOrderPaise: 5_000,
    }));
    expect(rich.guardrail.promotionCapacityPaise).toBe(5_000);
  });

  it("marks an order below the minimum as unsafe and between minimum and target as below target", () => {
    const thin = computeOrderEconomics(baseOrder({platformDiscountPaise: 3_500}), policy);
    expect(thin.guardrail.verdict).toBe("unsafe");
    const modest = computeOrderEconomics(baseOrder({platformDiscountPaise: 2_000}), policy);
    expect(modest.platform.contributionPaise).toBe(1_700);
    expect(modest.guardrail.verdict).toBe("below_target");
  });
});

describe("policy resolution", () => {
  it("layers city, zone and restaurant overrides over the global policy", () => {
    const resolved = resolveEconomicsPolicy({
      global: {minContributionPaisePerOrder: 500},
      cities: {nellore: {minContributionPaisePerOrder: 800, expansionReserveBps: 4_000}},
      zones: {"nellore|stonehousepet": {supportCostPaisePerOrder: 100}},
      restaurants: {r9: {maxPlatformSubsidyPerOrderPaise: 0}},
    }, {cityKey: "Nellore", zoneKey: "Stonehousepet", restaurantId: "r9"});
    expect(resolved.policy.minContributionPaisePerOrder).toBe(800);
    expect(resolved.policy.expansionReserveBps).toBe(4_000);
    expect(resolved.policy.supportCostPaisePerOrder).toBe(100);
    expect(resolved.policy.maxPlatformSubsidyPerOrderPaise).toBe(0);
    expect(resolved.appliedScopes).toEqual(["global", "city:nellore", "zone:nellore|stonehousepet", "restaurant:r9"]);
  });

  it("falls back to safe defaults and rejects out-of-range values", () => {
    expect(normalizeEconomicsPolicy(null)).toEqual(DEFAULT_ECONOMICS_POLICY);
    const clamped = normalizeEconomicsPolicy({paymentGatewayCostBps: 99_999, minContributionPaisePerOrder: -5});
    expect(clamped.paymentGatewayCostBps).toBe(1_000);
    expect(clamped.minContributionPaisePerOrder).toBe(0);
  });

  it("never lets the reserve buckets add up to more than the whole contribution", () => {
    const over = normalizeEconomicsPolicy({operatingReserveBps: 6_000, expansionReserveBps: 6_000, riskReserveBps: 3_000});
    expect(over.operatingReserveBps + over.expansionReserveBps + over.riskReserveBps).toBe(10_000);
    const split = allocateReserves(10_001, over);
    expect(split.distributablePaise).toBeGreaterThanOrEqual(0);
    expect(allocateReserves(-500, over)).toMatchObject({operatingReservePaise: 0, distributablePaise: -500});
  });
});

describe("promotion terms", () => {
  it("keeps legacy offers restaurant-funded and converts old rupee fields", () => {
    const legacy = normalizePromotionTerms("p1", {code: "save10", percent: 10, maxDiscount: 60, minimumOrder: 199, active: true});
    expect(legacy).toMatchObject({code: "SAVE10", fundingSource: "restaurant", legacyFunding: true,
      maxDiscountPaise: 6_000, minimumOrderPaise: 19_900});
    expect(promotionDiscountPaise(legacy, 100_000)).toBe(6_000);
    expect(promotionDiscountPaise(legacy, 30_000)).toBe(3_000);
  });

  it("supports flat offers without discounting more than the food", () => {
    const flat = normalizePromotionTerms("p2", {kind: "flat", flatAmountPaise: 10_000, fundingSource: "platform", active: true});
    expect(promotionDiscountPaise(flat, 25_000)).toBe(10_000);
    expect(promotionDiscountPaise(flat, 8_000)).toBe(8_000);
  });

  it("explains why an offer does not apply", () => {
    const at = Date.UTC(2026, 9, 1);
    const terms = normalizePromotionTerms("p3", {
      code: "NLR", percent: 20, active: true, fundingSource: "platform",
      minimumOrderPaise: 20_000, restaurantIds: ["r1"], cityKeys: ["Nellore"],
      budgetPaise: 100_000, usedBudgetPaise: 100_000,
    });
    const context = {subtotalPaise: 25_000, restaurantId: "r1", cityKey: "nellore", at};
    expect(promotionIneligibility(terms, context)).toBe("budget_exhausted");
    expect(promotionIneligibility({...terms, usedBudgetPaise: 0}, {...context, subtotalPaise: 10_000})).toBe("below_minimum");
    expect(promotionIneligibility({...terms, usedBudgetPaise: 0}, {...context, restaurantId: "r2"})).toBe("wrong_restaurant");
    expect(promotionIneligibility({...terms, usedBudgetPaise: 0}, {...context, cityKey: "guntur"})).toBe("wrong_city");
    expect(promotionIneligibility({...terms, usedBudgetPaise: 0, approvalStatus: "pending"}, context)).toBe("not_approved");
    expect(promotionIneligibility({...terms, usedBudgetPaise: 0}, context)).toBeNull();
  });
});

describe("commercial plans", () => {
  it("picks the plan in force at order time so later changes never rewrite history", () => {
    const plans = normalizeCommercialPlans([
      {planId: "founding", label: "Founding partner", commissionBps: 1_000, effectiveFrom: 100, effectiveTo: 500},
      {planId: "standard", label: "Standard", commissionBps: 1_500, effectiveFrom: 500, effectiveTo: 0},
    ]);
    expect(activeCommercialPlan(plans, 50)).toBeNull();
    expect(activeCommercialPlan(plans, 200)?.commissionBps).toBe(1_000);
    expect(activeCommercialPlan(plans, 500)?.commissionBps).toBe(1_500);
  });
});

describe("simulate before publish", () => {
  const base = {
    averageOrderValuePaise: 35_000,
    deliveryFeePaise: 2_500,
    platformFeePaise: 700,
    otherCustomerFeesPaise: 0,
    riderPayPerOrderPaise: 2_500,
    commissionBps: 1_000,
    onlinePaymentShareBps: 0,
    expectedOrders: 1_000,
    redemptionShareBps: 5_000,
  };

  it("flags a Rs 100 platform-funded offer as unsafe and says how much is safe", () => {
    const result = simulateOffer({
      ...base,
      offer: {kind: "flat", percent: 0, flatAmountPaise: 10_000, maxDiscountPaise: 0, fundingSource: "platform", restaurantShareBps: 0},
    }, policy);
    expect(result.verdict).toBe("unsafe");
    expect(result.platformFundedPerOrderPaise).toBe(10_000);
    expect(result.maximumSafePlatformFundingPaise).toBe(2_900);
    expect(result.contributionPerRedeemedOrderPaise).toBe(3_700 - 10_000);
    expect(result.worstCasePromoCostPaise).toBe(10_000 * 1_000);
    expect(result.message).toContain("Unsafe");
  });

  it("shows a restaurant-funded offer costing Scraveit only commission", () => {
    const result = simulateOffer({
      ...base,
      offer: {kind: "percent", percent: 20, flatAmountPaise: 0, maxDiscountPaise: 10_000, fundingSource: "restaurant", restaurantShareBps: 0},
    }, policy);
    expect(result.platformFundedPerOrderPaise).toBe(0);
    expect(result.restaurantFundedPerOrderPaise).toBe(7_000);
    expect(result.totalPromoCostPaise).toBe(0);
    expect(result.verdict).toBe("safe");
  });

  it("marks a small co-funded offer as below target but allowed", () => {
    const result = simulateOffer({
      ...base,
      offer: {kind: "flat", percent: 0, flatAmountPaise: 5_000, maxDiscountPaise: 0, fundingSource: "shared", restaurantShareBps: 6_000},
    }, policy);
    expect(result.platformFundedPerOrderPaise).toBe(2_000);
    expect(result.verdict).toBe("below_target");
  });
});
