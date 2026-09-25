/**
 * City P&L and expansion money.
 *
 *   revenue − variable costs            = contribution          (per order, summed)
 *   contribution − fixed operating costs = operating profit      (per city, per period)
 *
 * Contribution is NOT profit. Only operating profit, after the city's rent,
 * payroll, marketing and other fixed costs, can pay for the next city:
 *
 *   allocatable = operating profit − risk reserve − working-capital reserve
 *   expansion   = allocatable × expansion %
 *   retained    = allocatable − expansion
 */

export const OPERATING_COST_CATEGORIES = [
  "payroll", "rent", "cloud", "support", "marketing", "accounting", "legal",
  "banking_software", "equipment", "other",
] as const;
export type OperatingCostCategory = typeof OPERATING_COST_CATEGORIES[number];

export interface CityOperatingCost {
  id: string;
  cityKey: string;
  category: OperatingCostCategory;
  label: string;
  amountPaise: number;
  /** monthly: amountPaise every calendar month from startAt; one_time: once at startAt. */
  recurrence: "monthly" | "one_time";
  startAt: number;
  /** 0 = open ended (monthly only). */
  endAt: number;
  notes: string;
  reference: string;
  active: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonNegative(value: unknown): number {
  const parsed = Math.round(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeOperatingCost(id: string, value: unknown): CityOperatingCost {
  const input = record(value);
  const category = (OPERATING_COST_CATEGORIES as readonly string[]).includes(String(input.category)) ?
    input.category as OperatingCostCategory : "other";
  return {
    id,
    cityKey: String(input.cityKey ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    category,
    label: String(input.label ?? "").slice(0, 120),
    amountPaise: nonNegative(input.amountPaise),
    recurrence: input.recurrence === "one_time" ? "one_time" : "monthly",
    startAt: nonNegative(input.startAt),
    endAt: nonNegative(input.endAt),
    notes: String(input.notes ?? "").slice(0, 500),
    reference: String(input.reference ?? "").slice(0, 200),
    active: input.active !== false,
  };
}

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

/** Calendar month start (IST) containing `at`, and the next month's start. */
function istMonthBounds(at: number): {start: number; end: number} {
  const shifted = new Date(at + IST_OFFSET_MS);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - IST_OFFSET_MS;
  const end = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - IST_OFFSET_MS;
  return {start, end};
}

/**
 * The part of one cost that falls inside [startAt, endAt). A monthly cost is
 * spread evenly over each calendar month's days, so a 7-day window carries
 * 7/30ths (or 7/31sts) of that month's rent.
 */
export function operatingCostInPeriod(cost: CityOperatingCost, startAt: number, endAt: number): number {
  if (!cost.active || cost.amountPaise <= 0 || endAt <= startAt) return 0;
  if (cost.recurrence === "one_time") {
    return cost.startAt >= startAt && cost.startAt < endAt ? cost.amountPaise : 0;
  }
  const activeFrom = Math.max(startAt, cost.startAt);
  const activeTo = cost.endAt > 0 ? Math.min(endAt, cost.endAt) : endAt;
  if (activeTo <= activeFrom) return 0;
  let total = 0;
  let cursor = activeFrom;
  while (cursor < activeTo) {
    const month = istMonthBounds(cursor);
    const sliceEnd = Math.min(activeTo, month.end);
    total += cost.amountPaise * (sliceEnd - cursor) / (month.end - month.start);
    cursor = sliceEnd;
  }
  return Math.round(total);
}

export function operatingCostsByCategory(
  costs: readonly CityOperatingCost[],
  startAt: number,
  endAt: number,
): {totalPaise: number; byCategory: Record<string, number>} {
  const byCategory: Record<string, number> = {};
  let totalPaise = 0;
  for (const cost of costs) {
    const amount = operatingCostInPeriod(cost, startAt, endAt);
    if (!amount) continue;
    byCategory[cost.category] = (byCategory[cost.category] ?? 0) + amount;
    totalPaise += amount;
  }
  return {totalPaise, byCategory};
}

export interface CityFinancePolicy {
  /** How the expansion fund is decided. The city-profit mode is the safe default. */
  allocationMode: "city_operating_profit" | "order_contribution";
  riskReserveBps: number;
  workingCapitalReserveBps: number;
  expansionBps: number;
  minimumMonthlyOperatingProfitPaise: number;
  targetMonthlyOperatingProfitPaise: number;
  minimumMonthlyExpansionPaise: number;
  targetMonthlyExpansionPaise: number;
}

export const DEFAULT_CITY_FINANCE_POLICY: Readonly<CityFinancePolicy> = Object.freeze({
  allocationMode: "city_operating_profit",
  riskReserveBps: 1_500,
  workingCapitalReserveBps: 1_500,
  expansionBps: 4_000,
  minimumMonthlyOperatingProfitPaise: 0,
  targetMonthlyOperatingProfitPaise: 10_000_000,
  minimumMonthlyExpansionPaise: 0,
  targetMonthlyExpansionPaise: 3_000_000,
});

export function normalizeCityFinanceOverride(value: unknown): Partial<CityFinancePolicy> {
  const input = record(value);
  const output: Partial<CityFinancePolicy> = {};
  if (input.allocationMode === "city_operating_profit" || input.allocationMode === "order_contribution") {
    output.allocationMode = input.allocationMode;
  }
  const bpsFields = ["riskReserveBps", "workingCapitalReserveBps", "expansionBps"] as const;
  for (const field of bpsFields) {
    if (input[field] === undefined || input[field] === null || input[field] === "") continue;
    const parsed = Number(input[field]);
    if (Number.isFinite(parsed)) output[field] = Math.round(Math.min(10_000, Math.max(0, parsed)));
  }
  const paiseFields = ["minimumMonthlyOperatingProfitPaise", "targetMonthlyOperatingProfitPaise",
    "minimumMonthlyExpansionPaise", "targetMonthlyExpansionPaise"] as const;
  for (const field of paiseFields) {
    if (input[field] === undefined || input[field] === null || input[field] === "") continue;
    const parsed = Number(input[field]);
    if (Number.isFinite(parsed)) output[field] = Math.round(Math.min(1_000_000_000_00, Math.max(-1_000_000_000_00, parsed)));
  }
  return output;
}

export function resolveCityFinancePolicy(
  layers: {global?: Partial<CityFinancePolicy>; cities?: Record<string, Partial<CityFinancePolicy>>},
  cityKey: string,
): CityFinancePolicy {
  const merged = {
    ...DEFAULT_CITY_FINANCE_POLICY,
    ...normalizeCityFinanceOverride(layers.global),
    ...normalizeCityFinanceOverride(layers.cities?.[cityKey]),
  };
  // Risk + working capital can never claim more than the whole profit.
  const reserves = merged.riskReserveBps + merged.workingCapitalReserveBps;
  if (reserves > 10_000) {
    merged.workingCapitalReserveBps = Math.max(0, 10_000 - merged.riskReserveBps);
  }
  return merged;
}

export type CityHealth = "LOSS" | "BREAK_EVEN" | "BELOW_TARGET" | "HEALTHY";

export interface CityProfitAndLoss {
  days: number;
  grossContributionPaise: number;
  growthInvestmentPaise: number;
  fixedOperatingCostsPaise: number;
  fixedCostsByCategory: Record<string, number>;
  /** Contribution − growth investment − fixed costs: the real cash result. */
  operatingProfitPaise: number;
  riskReservePaise: number;
  workingCapitalReservePaise: number;
  allocatableProfitPaise: number;
  expansionAllocationPaise: number;
  retainedEarningsPaise: number;
  allocationMode: CityFinancePolicy["allocationMode"];
  /** Monthly targets scaled to this period's length. */
  targets: {
    minimumOperatingProfitPaise: number;
    targetOperatingProfitPaise: number;
    minimumExpansionPaise: number;
    targetExpansionPaise: number;
  };
  health: CityHealth;
  healthReason: string;
}

const bps = (amount: number, basis: number) => Math.round(amount * basis / 10_000);

export function cityProfitAndLoss(input: {
  startAt: number;
  endAt: number;
  grossContributionPaise: number;
  growthInvestmentPaise: number;
  costs: readonly CityOperatingCost[];
  policy: CityFinancePolicy;
}): CityProfitAndLoss {
  const days = Math.max(1, Math.round((input.endAt - input.startAt) / DAY_MS));
  const fixed = operatingCostsByCategory(input.costs, input.startAt, input.endAt);
  const operatingProfitPaise = input.grossContributionPaise - input.growthInvestmentPaise - fixed.totalPaise;
  // The legacy mode reserves from contribution; it is kept only for comparison
  // and never hides the fixed costs below it.
  const allocationBase = input.policy.allocationMode === "order_contribution" ?
    input.grossContributionPaise - input.growthInvestmentPaise : operatingProfitPaise;
  const positive = Math.max(0, allocationBase);
  const riskReservePaise = bps(positive, input.policy.riskReserveBps);
  const workingCapitalReservePaise = bps(positive, input.policy.workingCapitalReserveBps);
  // Expansion never exceeds the city's real operating profit, whichever mode is chosen.
  const allocatableProfitPaise = Math.max(0, Math.min(positive, Math.max(0, operatingProfitPaise)) -
    riskReservePaise - workingCapitalReservePaise);
  const expansionAllocationPaise = bps(allocatableProfitPaise, input.policy.expansionBps);
  const scale = (monthly: number) => Math.round(monthly * days / 30);
  const targets = {
    minimumOperatingProfitPaise: scale(input.policy.minimumMonthlyOperatingProfitPaise),
    targetOperatingProfitPaise: scale(input.policy.targetMonthlyOperatingProfitPaise),
    minimumExpansionPaise: scale(input.policy.minimumMonthlyExpansionPaise),
    targetExpansionPaise: scale(input.policy.targetMonthlyExpansionPaise),
  };
  let health: CityHealth;
  let healthReason: string;
  if (operatingProfitPaise < 0) {
    health = "LOSS";
    healthReason = "Fixed costs and subsidies are larger than what orders contribute.";
  } else if (operatingProfitPaise < targets.minimumOperatingProfitPaise || operatingProfitPaise === 0) {
    health = "BREAK_EVEN";
    healthReason = "The city covers its costs but not the minimum profit.";
  } else if (operatingProfitPaise < targets.targetOperatingProfitPaise ||
    expansionAllocationPaise < targets.minimumExpansionPaise) {
    health = "BELOW_TARGET";
    healthReason = expansionAllocationPaise < targets.minimumExpansionPaise ?
      "Profitable, but not yet producing the minimum expansion money." :
      "Profitable, but below the target operating profit.";
  } else {
    health = "HEALTHY";
    healthReason = "Meets the operating-profit target and funds expansion.";
  }
  return {
    days,
    grossContributionPaise: input.grossContributionPaise,
    growthInvestmentPaise: input.growthInvestmentPaise,
    fixedOperatingCostsPaise: fixed.totalPaise,
    fixedCostsByCategory: fixed.byCategory,
    operatingProfitPaise,
    riskReservePaise,
    workingCapitalReservePaise,
    allocatableProfitPaise,
    expansionAllocationPaise,
    retainedEarningsPaise: allocatableProfitPaise - expansionAllocationPaise,
    allocationMode: input.policy.allocationMode,
    targets,
    health,
    healthReason,
  };
}

// ---------------------------------------------------------------------------
// Break-even and forecast calculator
// ---------------------------------------------------------------------------

export interface BreakEvenInput {
  ordersPerDay: number;
  averageOrderValuePaise: number;
  commissionBps: number;
  customerFeesPerOrderPaise: number;
  riderCostPerOrderPaise: number;
  promoCostPerOrderPaise: number;
  paymentCostBps: number;
  refundRateBps: number;
  otherVariableCostPerOrderPaise: number;
  fixedMonthlyCostPaise: number;
  riskReserveBps: number;
  workingCapitalReserveBps: number;
  expansionBps: number;
  daysPerMonth?: number;
}

export interface BreakEvenResult {
  contributionPerOrderPaise: number;
  dailyContributionPaise: number;
  monthlyContributionPaise: number;
  breakEvenOrdersPerMonth: number | null;
  breakEvenOrdersPerDay: number | null;
  monthlyOperatingProfitPaise: number;
  monthlyExpansionPaise: number;
  monthlyRetainedPaise: number;
  explanation: string[];
}

export function breakEven(input: BreakEvenInput): BreakEvenResult {
  const days = input.daysPerMonth ?? 30;
  const billPaise = input.averageOrderValuePaise + input.customerFeesPerOrderPaise;
  const revenue = bps(input.averageOrderValuePaise, input.commissionBps) + input.customerFeesPerOrderPaise;
  const costs = input.riderCostPerOrderPaise + input.promoCostPerOrderPaise + bps(billPaise, input.paymentCostBps) +
    bps(billPaise, input.refundRateBps) + input.otherVariableCostPerOrderPaise;
  const contributionPerOrderPaise = revenue - costs;
  const dailyContributionPaise = contributionPerOrderPaise * Math.max(0, input.ordersPerDay);
  const monthlyContributionPaise = dailyContributionPaise * days;
  const breakEvenOrdersPerMonth = contributionPerOrderPaise > 0 ?
    Math.ceil(input.fixedMonthlyCostPaise / contributionPerOrderPaise) : null;
  const breakEvenOrdersPerDay = breakEvenOrdersPerMonth === null ? null : Math.ceil(breakEvenOrdersPerMonth / days);
  const monthlyOperatingProfitPaise = monthlyContributionPaise - input.fixedMonthlyCostPaise;
  const positive = Math.max(0, monthlyOperatingProfitPaise);
  const allocatable = Math.max(0, positive - bps(positive, input.riskReserveBps) - bps(positive, input.workingCapitalReserveBps));
  const monthlyExpansionPaise = bps(allocatable, input.expansionBps);
  const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
  const explanation = [
    `Contribution per order: ${rupees(contributionPerOrderPaise)} (revenue ${rupees(revenue)} − variable costs ${rupees(costs)}).`,
    breakEvenOrdersPerMonth === null ?
      "Each order loses money, so no order volume can cover the fixed costs. Fix unit economics first." :
      `Break-even: ${rupees(input.fixedMonthlyCostPaise)} ÷ ${rupees(contributionPerOrderPaise)} = ${breakEvenOrdersPerMonth.toLocaleString("en-IN")} orders/month ≈ ${breakEvenOrdersPerDay} orders/day.`,
    `At ${input.ordersPerDay} orders/day: ${rupees(monthlyContributionPaise)} contribution/month − ${rupees(input.fixedMonthlyCostPaise)} fixed = ${rupees(monthlyOperatingProfitPaise)} operating profit.`,
    `Expansion money: ${rupees(monthlyExpansionPaise)}/month after risk and working-capital reserves.`,
  ];
  return {
    contributionPerOrderPaise,
    dailyContributionPaise,
    monthlyContributionPaise,
    breakEvenOrdersPerMonth,
    breakEvenOrdersPerDay,
    monthlyOperatingProfitPaise,
    monthlyExpansionPaise,
    monthlyRetainedPaise: allocatable - monthlyExpansionPaise,
    explanation,
  };
}
