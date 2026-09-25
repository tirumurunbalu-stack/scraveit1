import {describe, expect, it} from "vitest";
import {
  DEFAULT_GUARANTEE_COMPONENTS,
  eligibleGuaranteeEarningsPaise,
  guaranteeTopUpPaise,
} from "../src/domain/earningsGuarantee";
import {
  nextReferralStatus,
  referralBudgetRemaining,
  referralDeadline,
  riderReferralProgrammeState,
  riderReferralProgress,
  riderReferralRiskFlags,
  simulateRiderReferralCost,
} from "../src/domain/riderReferral";

const terms = {inviterRewardPaise: 500_000, inviteeRewardPaise: 0, qualifyingDeliveredOrders: 250};
const open = {status: "in_progress" as const, deadlineAt: 0, at: 1, reviewRequired: false, reviewDecision: "" as const, target: 250};

describe("rider referral rules", () => {
  it("qualifies at exactly the target, not one delivery before", () => {
    expect(nextReferralStatus({...open, deliveredCount: 249})).toBe("in_progress");
    expect(nextReferralStatus({...open, deliveredCount: 250})).toBe("qualified");
    expect(nextReferralStatus({...open, status: "paid", deliveredCount: 300})).toBe("paid");
  });

  it("holds flagged referrals until an admin decides", () => {
    expect(nextReferralStatus({...open, deliveredCount: 250, reviewRequired: true})).toBe("review");
    expect(nextReferralStatus({...open, status: "review", deliveredCount: 250, reviewRequired: true, reviewDecision: "approved"}))
      .toBe("qualified");
    expect(nextReferralStatus({...open, deliveredCount: 10, reviewDecision: "rejected"})).toBe("rejected");
  });

  it("expires only when the deadline passes before the target", () => {
    const deadlineAt = referralDeadline(0, 30);
    expect(deadlineAt).toBe(30 * 24 * 60 * 60 * 1000);
    expect(referralDeadline(0, 0)).toBe(0);
    expect(nextReferralStatus({...open, deliveredCount: 100, deadlineAt, at: deadlineAt})).toBe("expired");
    expect(nextReferralStatus({...open, deliveredCount: 100, deadlineAt, at: deadlineAt - 1})).toBe("in_progress");
  });

  it("reports progress as 183 / 250 with 67 remaining", () => {
    expect(riderReferralProgress(183, 250)).toEqual({delivered: 183, target: 250, remaining: 67, percent: 73});
    expect(riderReferralProgress(300, 250)).toMatchObject({remaining: 0, percent: 100});
  });

  it("closes the programme when paused, outside its dates, or when the budget cannot cover one more reward", () => {
    const budget = {budgetPaise: 0, spentPaise: 0, reservedPaise: 0};
    const base = {active: true, startAt: 0, endAt: 0, terms, budget};
    expect(riderReferralProgrammeState(base, 10)).toBe("active");
    expect(riderReferralProgrammeState({...base, active: false}, 10)).toBe("paused");
    expect(riderReferralProgrammeState({...base, startAt: 20}, 10)).toBe("not_started");
    expect(riderReferralProgrammeState({...base, endAt: 10}, 10)).toBe("closed");
    const tight = {budgetPaise: 800_000, spentPaise: 0, reservedPaise: 500_000};
    expect(referralBudgetRemaining(tight)).toBe(300_000);
    expect(riderReferralProgrammeState({...base, budget: tight}, 10)).toBe("budget_exhausted");
    expect(referralBudgetRemaining(budget)).toBeNull();
  });

  it("flags matching identity details without deciding anything", () => {
    expect(riderReferralRiskFlags(
      {phone: "+91 90000 00001", panNumber: "ABCDE1234F", vehicleNumber: "AP 26 AB 1234"},
      {phone: "9000000001", panNumber: "abcde1234f", vehicleNumber: "AP26AB1234"},
    )).toEqual(["same_phone", "same_pan", "same_vehicle"]);
    expect(riderReferralRiskFlags({phone: "9000000001"}, {phone: "9000000002"})).toEqual([]);
    expect(riderReferralRiskFlags({}, {})).toEqual([]);
  });

  it("simulates expected and worst-case cost from the configured reward", () => {
    const result = simulateRiderReferralCost({
      expectedReferredRiders: 100, qualificationRateBps: 3_000, terms, maxRewardsPerInviter: 5,
      remainingBudgetPaise: 20_000_000, reservedPaise: 0,
    });
    expect(result).toMatchObject({
      rewardPerReferralPaise: 500_000,
      expectedQualified: 30,
      expectedCostPaise: 15_000_000, // 30 × ₹5,000 = ₹1,50,000
      worstCaseCostPaise: 50_000_000, // 100 × ₹5,000 = ₹5,00,000
      maxExposurePerInviterPaise: 2_500_000, // 5 × ₹5,000 = ₹25,000
      budgetCoversExpected: true,
      budgetCoversWorstCase: false,
      operatingProfitAfterPaise: null,
    });
    const changed = simulateRiderReferralCost({
      expectedReferredRiders: 10, qualificationRateBps: 5_000,
      terms: {inviterRewardPaise: 600_000, inviteeRewardPaise: 0, qualifyingDeliveredOrders: 300},
      maxRewardsPerInviter: 0, remainingBudgetPaise: null, reservedPaise: 0,
      monthlyOperatingProfitPaise: 1_000_000, monthlyExpansionFundPaise: 400_000,
    });
    expect(changed).toMatchObject({
      expectedCostPaise: 3_000_000, maxExposurePerInviterPaise: null, budgetCoversExpected: null,
      operatingProfitAfterPaise: -2_000_000, expansionFundAfterPaise: 0,
    });
  });

  it("never lets a referral reward shrink the earnings guarantee top-up by default", () => {
    const breakdown = {
      tripPayPaise: 140_000, perOrderIncentivesPaise: 0, tipsPaise: 0, referralRewardsPaise: 500_000, otherGuaranteesPaise: 0,
    };
    const eligible = eligibleGuaranteeEarningsPaise(breakdown, DEFAULT_GUARANTEE_COMPONENTS);
    expect(eligible).toBe(140_000);
    expect(guaranteeTopUpPaise(168_000, eligible)).toBe(28_000); // ₹1,680 − ₹1,400 = ₹280
    expect(eligibleGuaranteeEarningsPaise(breakdown, ["trip_pay", "referral_rewards"])).toBe(640_000);
  });
});
