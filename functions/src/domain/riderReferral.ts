/**
 * Rider referral programme: pure rules.
 *
 * A referral is one referred rider. Its terms (reward, deliveries needed,
 * deadline) are frozen on its own record when it is accepted, so later
 * programme changes only affect new referrals. The inviter is paid once, when
 * the referred rider's qualifying delivered orders reach the frozen target.
 */

export const RIDER_REFERRAL_PROGRAMME_ID = "rider_referral_program";

/** Current default: ₹5,000 after 250 successful delivered orders. */
export const RIDER_REFERRAL_DEFAULT_REWARD_PAISE = 500_000;
export const RIDER_REFERRAL_DEFAULT_QUALIFYING_ORDERS = 250;
/** Version 1 was the ₹500 / 25-order programme. */
export const RIDER_REFERRAL_DEFAULT_PROGRAMME_VERSION = 2;

/** The ₹500 / 25-order programme that ran before terms were frozen per referral. */
export const LEGACY_RIDER_REFERRAL_TERMS: Readonly<RiderReferralTerms> = Object.freeze({
  inviterRewardPaise: 50_000,
  inviteeRewardPaise: 0,
  qualifyingDeliveredOrders: 25,
  qualificationDays: 0,
});

/**
 * Riders who applied before this moment joined under the old programme and
 * keep its terms. Anyone applying later gets a frozen record at application.
 */
export const RIDER_REFERRAL_FROZEN_TERMS_SINCE = Date.parse("2026-09-25T00:00:00+05:30");

export interface RiderReferralTerms {
  inviterRewardPaise: number;
  inviteeRewardPaise: number;
  qualifyingDeliveredOrders: number;
  /** Days from acceptance to reach the target. 0 = no deadline. */
  qualificationDays: number;
}

export type RiderReferralStatus =
  | "in_progress" // accepted; counting deliveries
  | "review" // target reached but held for an admin check
  | "qualified" // target reached; reward being credited
  | "paid" // reward credited to the inviter's earnings
  | "expired" // deadline passed before the target
  | "rejected" // admin rejected, or application rejected
  | "not_eligible"; // never accepted (self-referral, limits, budget, closed)

export const OPEN_REFERRAL_STATUSES: readonly RiderReferralStatus[] = ["in_progress", "review", "qualified"];

export type RiderReferralProgrammeState = "active" | "paused" | "not_started" | "closed" | "budget_exhausted";

export interface RiderReferralBudget {
  budgetPaise: number;
  spentPaise: number;
  reservedPaise: number;
}

export function referralRewardTotal(terms: Pick<RiderReferralTerms, "inviterRewardPaise" | "inviteeRewardPaise">): number {
  return Math.max(0, terms.inviterRewardPaise) + Math.max(0, terms.inviteeRewardPaise);
}

/** Remaining money not yet spent or promised. null = no budget cap. */
export function referralBudgetRemaining(budget: RiderReferralBudget): number | null {
  if (budget.budgetPaise <= 0) return null;
  return Math.max(0, budget.budgetPaise - budget.spentPaise - budget.reservedPaise);
}

export function riderReferralProgrammeState(
  input: {
    active: boolean;
    startAt: number;
    endAt: number;
    terms: Pick<RiderReferralTerms, "inviterRewardPaise" | "inviteeRewardPaise">;
    budget: RiderReferralBudget;
  },
  at: number,
): RiderReferralProgrammeState {
  if (!input.active) return "paused";
  if (input.startAt && at < input.startAt) return "not_started";
  if (input.endAt && at >= input.endAt) return "closed";
  const remaining = referralBudgetRemaining(input.budget);
  if (remaining !== null && remaining < referralRewardTotal(input.terms)) return "budget_exhausted";
  return "active";
}

export interface RiderReferralProgress {
  delivered: number;
  target: number;
  remaining: number;
  /** 0–100, whole numbers. */
  percent: number;
}

export function riderReferralProgress(deliveredCount: number, target: number): RiderReferralProgress {
  const safeTarget = Math.max(1, Math.floor(target));
  const delivered = Math.max(0, Math.floor(deliveredCount));
  return {
    delivered,
    target: safeTarget,
    remaining: Math.max(0, safeTarget - delivered),
    percent: Math.min(100, Math.floor((delivered * 100) / safeTarget)),
  };
}

export function referralDeadline(acceptedAt: number, qualificationDays: number): number {
  return qualificationDays > 0 ? acceptedAt + qualificationDays * 24 * 60 * 60 * 1000 : 0;
}

/**
 * What happens to an open referral after one more counted delivery (or a
 * re-check). Pure so the transaction and the tests share one rule.
 */
export function nextReferralStatus(input: {
  status: RiderReferralStatus;
  deliveredCount: number;
  target: number;
  deadlineAt: number;
  at: number;
  reviewRequired: boolean;
  reviewDecision: "" | "approved" | "rejected";
}): RiderReferralStatus {
  if (input.status !== "in_progress" && input.status !== "review") return input.status;
  if (input.reviewDecision === "rejected") return "rejected";
  const reached = input.deliveredCount >= Math.max(1, input.target);
  if (!reached) {
    if (input.deadlineAt && input.at >= input.deadlineAt) return "expired";
    return "in_progress";
  }
  if (input.reviewRequired && input.reviewDecision !== "approved") return "review";
  return "qualified";
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function digits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "").slice(-10);
}

/**
 * Signals that the referred rider may be the inviter (or a second account of
 * someone). They only hold the reward for an admin decision; nobody is
 * rejected or banned on these alone.
 */
export function riderReferralRiskFlags(
  inviter: Record<string, unknown>,
  referred: Record<string, unknown>,
): string[] {
  const flags: string[] = [];
  const same = (a: unknown, b: unknown, clean: (value: unknown) => string, minLength: number) => {
    const left = clean(a);
    return left.length >= minLength && left === clean(b);
  };
  if (same(inviter.phone, referred.phone, digits, 10)) flags.push("same_phone");
  if (same(inviter.panNumber, referred.panNumber, normalized, 10)) flags.push("same_pan");
  if (same(inviter.vehicleNumber, referred.vehicleNumber, normalized, 6)) flags.push("same_vehicle");
  if (same(inviter.address, referred.address, normalized, 12)) flags.push("same_address");
  if (same(inviter.email, referred.email, normalized, 6)) flags.push("same_email");
  if (same(inviter.bankAccountLast4 ?? inviter.upiId, referred.bankAccountLast4 ?? referred.upiId, normalized, 4)) {
    flags.push("same_payout_account");
  }
  return flags;
}

export function isTestAccount(profile: Record<string, unknown>): boolean {
  return profile.testAccount === true || profile.isTestAccount === true;
}

export interface RiderReferralSimulationInput {
  expectedReferredRiders: number;
  /** Share of referred riders expected to reach the target, in basis points. */
  qualificationRateBps: number;
  terms: Pick<RiderReferralTerms, "inviterRewardPaise" | "inviteeRewardPaise" | "qualifyingDeliveredOrders">;
  maxRewardsPerInviter: number;
  /** null = no programme cap. */
  remainingBudgetPaise: number | null;
  /** Current open referrals' promised money, already reserved. */
  reservedPaise: number;
  /** Last 30 days of the city, when known. */
  monthlyOperatingProfitPaise?: number | null;
  monthlyExpansionFundPaise?: number | null;
  expansionShareBps?: number;
}

export interface RiderReferralSimulation {
  rewardPerReferralPaise: number;
  expectedQualified: number;
  expectedCostPaise: number;
  worstCaseCostPaise: number;
  maxExposurePerInviterPaise: number | null;
  budgetCoversExpected: boolean | null;
  budgetCoversWorstCase: boolean | null;
  operatingProfitAfterPaise: number | null;
  expansionFundAfterPaise: number | null;
}

/**
 * Expected and worst-case cost of a batch of new referrals, from the actual
 * configured reward. Referral cost is a period cost, so the city effect is
 * shown against a month of operating profit.
 */
export function simulateRiderReferralCost(input: RiderReferralSimulationInput): RiderReferralSimulation {
  const riders = Math.max(0, Math.floor(input.expectedReferredRiders));
  const rateBps = Math.min(10_000, Math.max(0, Math.floor(input.qualificationRateBps)));
  const reward = referralRewardTotal(input.terms);
  const expectedQualified = Math.round((riders * rateBps) / 10_000);
  const expectedCostPaise = expectedQualified * reward;
  const worstCaseCostPaise = riders * reward;
  const remaining = input.remainingBudgetPaise;
  const profit = input.monthlyOperatingProfitPaise ?? null;
  let expansionAfter: number | null = null;
  if (profit !== null && input.monthlyExpansionFundPaise !== undefined && input.monthlyExpansionFundPaise !== null) {
    // The fund is a share of what is left after reserves; lowering operating
    // profit lowers it in the same proportion, and never below zero.
    const after = profit - expectedCostPaise;
    expansionAfter = profit > 0 && after > 0
      ? Math.floor((input.monthlyExpansionFundPaise * after) / profit)
      : 0;
  }
  return {
    rewardPerReferralPaise: reward,
    expectedQualified,
    expectedCostPaise,
    worstCaseCostPaise,
    maxExposurePerInviterPaise: input.maxRewardsPerInviter > 0 ? input.maxRewardsPerInviter * input.terms.inviterRewardPaise : null,
    budgetCoversExpected: remaining === null ? null : remaining >= expectedCostPaise,
    budgetCoversWorstCase: remaining === null ? null : remaining >= worstCaseCostPaise,
    operatingProfitAfterPaise: profit === null ? null : profit - expectedCostPaise,
    expansionFundAfterPaise: expansionAfter,
  };
}
