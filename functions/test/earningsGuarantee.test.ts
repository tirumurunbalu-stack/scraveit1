import {describe, expect, it} from "vitest";
import {
  DEFAULT_GUARANTEE_COMPONENTS,
  eligibleGuaranteeEarningsPaise,
  evaluateGuarantee,
  guaranteeLiabilityEstimate,
  guaranteeTopUpPaise,
  normalizeGuaranteeComponents,
  qualifiedGuaranteeTier,
} from "../src/domain/earningsGuarantee";

const DINNER_TIERS = [
  {target: 7, guaranteedPaise: 52_500},
  {target: 13, guaranteedPaise: 100_100},
  {target: 21, guaranteedPaise: 168_000},
  {target: 40, guaranteedPaise: 352_000},
];

function breakdown(tripPayPaise: number, extra: Partial<Parameters<typeof eligibleGuaranteeEarningsPaise>[0]> = {}) {
  return {tripPayPaise, perOrderIncentivesPaise: 0, tipsPaise: 0, referralRewardsPaise: 0, otherGuaranteesPaise: 0, ...extra};
}

describe("minimum earnings guarantee", () => {
  it("tops Rs 1,340 up to a Rs 1,680 guarantee: Scraveit pays Rs 340, not Rs 1,680", () => {
    expect(guaranteeTopUpPaise(168_000, 134_000)).toBe(34_000);
    const result = evaluateGuarantee({
      tiers: DINNER_TIERS, completedDeliveries: 21, breakdown: breakdown(134_000),
      components: DEFAULT_GUARANTEE_COMPONENTS, conditionsMet: true,
    });
    expect(result.topUpPaise).toBe(34_000);
    expect(result.finalEarningsPaise).toBe(168_000);
  });

  it("owes nothing when the rider already earned more than the guarantee", () => {
    const result = evaluateGuarantee({
      tiers: DINNER_TIERS, completedDeliveries: 21, breakdown: breakdown(185_000),
      components: DEFAULT_GUARANTEE_COMPONENTS, conditionsMet: true,
    });
    expect(result.topUpPaise).toBe(0);
    expect(result.finalEarningsPaise).toBe(185_000);
  });

  it("pays nothing when the delivery target was not reached", () => {
    const result = evaluateGuarantee({
      tiers: [{target: 21, guaranteedPaise: 168_000}], completedDeliveries: 20, breakdown: breakdown(100_000),
      components: DEFAULT_GUARANTEE_COMPONENTS, conditionsMet: true,
    });
    expect(result.tier).toBeNull();
    expect(result.topUpPaise).toBe(0);
    expect(result.nextTier?.target).toBe(21);
  });

  it("pays nothing when login time or reject limits were broken", () => {
    const result = evaluateGuarantee({
      tiers: DINNER_TIERS, completedDeliveries: 25, breakdown: breakdown(100_000),
      components: DEFAULT_GUARANTEE_COMPONENTS, conditionsMet: false,
    });
    expect(result.tier?.target).toBe(21);
    expect(result.topUpPaise).toBe(0);
  });

  it("selects only the highest reached tier - tiers never add together", () => {
    expect(qualifiedGuaranteeTier(DINNER_TIERS, 12)?.guaranteedPaise).toBe(52_500);
    expect(qualifiedGuaranteeTier(DINNER_TIERS, 30)?.guaranteedPaise).toBe(168_000);
    expect(qualifiedGuaranteeTier(DINNER_TIERS, 40)?.guaranteedPaise).toBe(352_000);
    const result = evaluateGuarantee({
      tiers: DINNER_TIERS, completedDeliveries: 40, breakdown: breakdown(310_000),
      components: DEFAULT_GUARANTEE_COMPONENTS, conditionsMet: true,
    });
    expect(result.topUpPaise).toBe(42_000);
  });

  it("does not count customer tips against the guarantee by default", () => {
    const withTips = breakdown(134_000, {tipsPaise: 20_000});
    expect(eligibleGuaranteeEarningsPaise(withTips, DEFAULT_GUARANTEE_COMPONENTS)).toBe(134_000);
    expect(guaranteeTopUpPaise(168_000, eligibleGuaranteeEarningsPaise(withTips, DEFAULT_GUARANTEE_COMPONENTS))).toBe(34_000);
    // Only an explicit campaign rule lets tips count.
    expect(eligibleGuaranteeEarningsPaise(withTips, ["trip_pay", "tips"])).toBe(154_000);
  });

  it("does not let one guarantee's top-up feed another unless configured", () => {
    const earned = breakdown(100_000, {otherGuaranteesPaise: 50_000, perOrderIncentivesPaise: 5_000});
    expect(eligibleGuaranteeEarningsPaise(earned, DEFAULT_GUARANTEE_COMPONENTS)).toBe(105_000);
    expect(normalizeGuaranteeComponents(undefined)).toEqual(["trip_pay", "per_order_incentives"]);
    expect(normalizeGuaranteeComponents(["tips", "bogus"])).toEqual(["tips"]);
    expect(normalizeGuaranteeComponents([])).toEqual(["trip_pay", "per_order_incentives"]);
  });

  it("estimates expected and worst-case liability before a campaign goes live", () => {
    const estimate = guaranteeLiabilityEstimate({
      tiers: DINNER_TIERS,
      maxRiders: 20,
      expectedRiders: 12,
      minimumEarningPerDeliveryPaise: 2_500,
      expectedEarningPerDeliveryPaise: 6_500,
      budgetPaise: 0,
    });
    // Worst case: 40 orders at Rs 25 = Rs 1,000 against Rs 3,520 -> Rs 2,520 per rider.
    expect(estimate.worstCasePerRiderPaise).toBe(252_000);
    expect(estimate.worstCasePaise).toBe(252_000 * 20);
    // Expected: 40 * 65 = 2,600 vs 3,520 -> 920; 21 * 65 = 1,365 vs 1,680 -> 315. Highest is 920.
    expect(estimate.expectedPerRiderPaise).toBe(92_000);
    expect(estimate.expectedPaise).toBe(92_000 * 12);
    const budgeted = guaranteeLiabilityEstimate({
      tiers: DINNER_TIERS, maxRiders: 20, expectedRiders: 12,
      minimumEarningPerDeliveryPaise: 2_500, expectedEarningPerDeliveryPaise: 6_500, budgetPaise: 500_000,
    });
    expect(budgeted.worstCasePaise).toBe(500_000);
    expect(budgeted.budgetBound).toBe(true);
    expect(budgeted.withinBudget).toBe(false);
  });
});
