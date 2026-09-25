/**
 * Minimum earnings guarantee - a TOP-UP, never an additive bonus.
 *
 *   topUp = max(0, guaranteed - eligibleEarnings)
 *   final = eligibleEarnings + topUp = max(eligibleEarnings, guaranteed)
 *
 * A Rs 1,680 guarantee against Rs 1,340 of eligible earnings costs Scraveit
 * Rs 340, not Rs 1,680; a rider who earned Rs 1,850 is owed nothing extra.
 */

export type GuaranteeEarningComponent =
  | "trip_pay"
  | "per_order_incentives"
  | "tips"
  | "referral_rewards"
  | "other_guarantees";

/**
 * What counts toward the guarantee unless a campaign says otherwise. Tips are
 * the customer's gift to the rider and must not quietly shrink a top-up;
 * another guarantee's top-up counting here would let two guarantees feed each
 * other; referral rewards are for recruiting, not for this shift's work.
 */
export const DEFAULT_GUARANTEE_COMPONENTS: readonly GuaranteeEarningComponent[] = Object.freeze([
  "trip_pay",
  "per_order_incentives",
]);

export const ALL_GUARANTEE_COMPONENTS: readonly GuaranteeEarningComponent[] = Object.freeze([
  "trip_pay",
  "per_order_incentives",
  "tips",
  "referral_rewards",
  "other_guarantees",
]);

export function normalizeGuaranteeComponents(value: unknown): GuaranteeEarningComponent[] {
  if (!Array.isArray(value)) return [...DEFAULT_GUARANTEE_COMPONENTS];
  const allowed = new Set<string>(ALL_GUARANTEE_COMPONENTS);
  const picked = [...new Set(value.map(String).filter((entry) => allowed.has(entry)))] as GuaranteeEarningComponent[];
  return picked.length ? picked : [...DEFAULT_GUARANTEE_COMPONENTS];
}

export interface GuaranteeEarningsBreakdown {
  tripPayPaise: number;
  perOrderIncentivesPaise: number;
  tipsPaise: number;
  referralRewardsPaise: number;
  otherGuaranteesPaise: number;
}

export function eligibleGuaranteeEarningsPaise(
  breakdown: GuaranteeEarningsBreakdown,
  components: readonly GuaranteeEarningComponent[],
): number {
  const include = new Set(components);
  return (include.has("trip_pay") ? breakdown.tripPayPaise : 0) +
    (include.has("per_order_incentives") ? breakdown.perOrderIncentivesPaise : 0) +
    (include.has("tips") ? breakdown.tipsPaise : 0) +
    (include.has("referral_rewards") ? breakdown.referralRewardsPaise : 0) +
    (include.has("other_guarantees") ? breakdown.otherGuaranteesPaise : 0);
}

export function guaranteeTopUpPaise(guaranteedPaise: number, eligibleEarningsPaise: number): number {
  const guaranteed = Math.max(0, Math.round(guaranteedPaise));
  const earned = Math.max(0, Math.round(eligibleEarningsPaise));
  return Math.max(0, guaranteed - earned);
}

export interface GuaranteeTier {
  target: number;
  guaranteedPaise: number;
}

/** The highest tier whose delivery target was reached - tiers never add up. */
export function qualifiedGuaranteeTier(tiers: readonly GuaranteeTier[], completedDeliveries: number): GuaranteeTier | null {
  const reached = tiers
    .filter((tier) => tier.target > 0 && completedDeliveries >= tier.target)
    .sort((left, right) => right.target - left.target || right.guaranteedPaise - left.guaranteedPaise);
  return reached[0] ?? null;
}

export function nextGuaranteeTier(tiers: readonly GuaranteeTier[], completedDeliveries: number): GuaranteeTier | null {
  return [...tiers]
    .filter((tier) => tier.target > completedDeliveries)
    .sort((left, right) => left.target - right.target)[0] ?? null;
}

export interface GuaranteeEvaluation {
  tier: GuaranteeTier | null;
  nextTier: GuaranteeTier | null;
  eligibleEarningsPaise: number;
  /** What would be paid if the period closed now with every condition met. */
  topUpPaise: number;
  finalEarningsPaise: number;
}

export function evaluateGuarantee(input: {
  tiers: readonly GuaranteeTier[];
  completedDeliveries: number;
  breakdown: GuaranteeEarningsBreakdown;
  components: readonly GuaranteeEarningComponent[];
  conditionsMet: boolean;
}): GuaranteeEvaluation {
  const tier = qualifiedGuaranteeTier(input.tiers, input.completedDeliveries);
  const eligibleEarningsPaise = eligibleGuaranteeEarningsPaise(input.breakdown, input.components);
  const topUpPaise = tier && input.conditionsMet ? guaranteeTopUpPaise(tier.guaranteedPaise, eligibleEarningsPaise) : 0;
  return {
    tier,
    nextTier: nextGuaranteeTier(input.tiers, input.completedDeliveries),
    eligibleEarningsPaise,
    topUpPaise,
    finalEarningsPaise: eligibleEarningsPaise + topUpPaise,
  };
}

/**
 * Liability a guarantee campaign can create, shown to the admin before it is
 * switched on. The worst case assumes every allowed rider reaches the top tier
 * while earning only the minimum per delivery; the expected case uses the
 * admin's estimate of normal per-delivery earnings.
 */
export function guaranteeLiabilityEstimate(input: {
  tiers: readonly GuaranteeTier[];
  maxRiders: number;
  expectedRiders: number;
  minimumEarningPerDeliveryPaise: number;
  expectedEarningPerDeliveryPaise: number;
  budgetPaise: number;
}): {
  worstCasePerRiderPaise: number;
  worstCasePaise: number;
  expectedPerRiderPaise: number;
  expectedPaise: number;
  withinBudget: boolean;
  budgetBound: boolean;
} {
  const perRider = (earningPerDelivery: number) => input.tiers.reduce((max, tier) =>
    Math.max(max, guaranteeTopUpPaise(tier.guaranteedPaise, tier.target * Math.max(0, earningPerDelivery))), 0);
  const worstCasePerRiderPaise = perRider(input.minimumEarningPerDeliveryPaise);
  const expectedPerRiderPaise = perRider(input.expectedEarningPerDeliveryPaise);
  const riders = Math.max(0, Math.round(input.maxRiders));
  const expected = Math.max(0, Math.min(riders || Number.MAX_SAFE_INTEGER, Math.round(input.expectedRiders)));
  const rawWorst = worstCasePerRiderPaise * riders;
  const budget = Math.max(0, Math.round(input.budgetPaise));
  return {
    worstCasePerRiderPaise,
    worstCasePaise: budget > 0 ? Math.min(rawWorst, budget) : rawWorst,
    expectedPerRiderPaise,
    expectedPaise: expectedPerRiderPaise * expected,
    withinBudget: budget === 0 || expectedPerRiderPaise * expected <= budget,
    budgetBound: budget > 0 && rawWorst > budget,
  };
}
