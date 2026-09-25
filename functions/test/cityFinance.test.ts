import {describe, expect, it} from "vitest";
import {
  DEFAULT_CITY_FINANCE_POLICY,
  breakEven,
  cityProfitAndLoss,
  normalizeOperatingCost,
  operatingCostInPeriod,
  resolveCityFinancePolicy,
  type CityFinancePolicy,
} from "../src/domain/cityFinance";
import {activeTaxVersion, computeTaxLines, normalizeTaxVersions} from "../src/domain/taxRules";

const IST = (date: string) => Date.parse(`${date}T00:00:00+05:30`);

describe("city fixed operating costs", () => {
  const rent = normalizeOperatingCost("rent", {cityKey: "Nellore", category: "rent", amountPaise: 3_000_000,
    recurrence: "monthly", startAt: IST("2026-09-01")});

  it("counts a monthly cost in full for its whole month", () => {
    expect(operatingCostInPeriod(rent, IST("2026-10-01"), IST("2026-11-01"))).toBe(3_000_000);
  });

  it("spreads a monthly cost over the days of the month", () => {
    // 7 of October's 31 days.
    expect(operatingCostInPeriod(rent, IST("2026-10-01"), IST("2026-10-08"))).toBe(Math.round(3_000_000 * 7 / 31));
  });

  it("ignores costs outside their active dates and one-off costs outside the period", () => {
    const ended = {...rent, endAt: IST("2026-10-01")};
    expect(operatingCostInPeriod(ended, IST("2026-10-01"), IST("2026-11-01"))).toBe(0);
    const laptop = normalizeOperatingCost("eq", {cityKey: "nellore", category: "equipment", amountPaise: 5_000_000,
      recurrence: "one_time", startAt: IST("2026-10-10")});
    expect(operatingCostInPeriod(laptop, IST("2026-10-01"), IST("2026-11-01"))).toBe(5_000_000);
    expect(operatingCostInPeriod(laptop, IST("2026-11-01"), IST("2026-12-01"))).toBe(0);
  });
});

describe("city P&L: contribution is not profit", () => {
  const policy: CityFinancePolicy = {...DEFAULT_CITY_FINANCE_POLICY, riskReserveBps: 1_000, workingCapitalReserveBps: 1_000,
    expansionBps: 4_000, minimumMonthlyOperatingProfitPaise: 0, targetMonthlyOperatingProfitPaise: 10_000_000,
    minimumMonthlyExpansionPaise: 0, targetMonthlyExpansionPaise: 0};
  const costs = [normalizeOperatingCost("fixed", {cityKey: "nellore", category: "payroll", amountPaise: 18_000_000,
    recurrence: "monthly", startAt: IST("2026-01-01")})];

  it("subtracts fixed costs and growth investment before any expansion money exists", () => {
    const pnl = cityProfitAndLoss({startAt: IST("2026-10-01"), endAt: IST("2026-10-31"), grossContributionPaise: 32_400_000,
      growthInvestmentPaise: 400_000, costs, policy});
    // 30 of 31 days of ₹1,80,000.
    const fixed = Math.round(18_000_000 * 30 / 31);
    expect(pnl.fixedOperatingCostsPaise).toBe(fixed);
    expect(pnl.operatingProfitPaise).toBe(32_400_000 - 400_000 - fixed);
    expect(pnl.riskReservePaise).toBe(Math.round(pnl.operatingProfitPaise * 0.1));
    expect(pnl.allocatableProfitPaise).toBe(pnl.operatingProfitPaise - pnl.riskReservePaise - pnl.workingCapitalReservePaise);
    expect(pnl.expansionAllocationPaise).toBe(Math.round(pnl.allocatableProfitPaise * 0.4));
    expect(pnl.retainedEarningsPaise).toBe(pnl.allocatableProfitPaise - pnl.expansionAllocationPaise);
  });

  it("is a LOSS when every order made money but fixed costs were larger", () => {
    const pnl = cityProfitAndLoss({startAt: IST("2026-10-01"), endAt: IST("2026-10-31"), grossContributionPaise: 9_000_000,
      growthInvestmentPaise: 0, costs, policy});
    expect(pnl.health).toBe("LOSS");
    expect(pnl.expansionAllocationPaise).toBe(0);
  });

  it("classifies BREAK_EVEN, BELOW_TARGET and HEALTHY against monthly targets scaled to the period", () => {
    const at = (contribution: number, overrides: Partial<CityFinancePolicy> = {}) => cityProfitAndLoss({
      startAt: IST("2026-10-01"), endAt: IST("2026-10-31"), grossContributionPaise: contribution,
      growthInvestmentPaise: 0, costs: [], policy: {...policy, minimumMonthlyOperatingProfitPaise: 2_000_000, ...overrides},
    }).health;
    expect(at(1_000_000)).toBe("BREAK_EVEN");
    expect(at(5_000_000)).toBe("BELOW_TARGET");
    expect(at(20_000_000)).toBe("HEALTHY");
    expect(at(20_000_000, {minimumMonthlyExpansionPaise: 10_000_000})).toBe("BELOW_TARGET");
  });

  it("never allocates expansion money beyond operating profit, even in contribution mode", () => {
    const pnl = cityProfitAndLoss({startAt: IST("2026-10-01"), endAt: IST("2026-10-31"), grossContributionPaise: 9_000_000,
      growthInvestmentPaise: 0, costs, policy: {...policy, allocationMode: "order_contribution"}});
    expect(pnl.operatingProfitPaise).toBeLessThan(0);
    expect(pnl.expansionAllocationPaise).toBe(0);
  });

  it("keeps separate cities' policies separate", () => {
    const layers = {global: {expansionBps: 3_000}, cities: {nellore: {expansionBps: 5_000}}};
    expect(resolveCityFinancePolicy(layers, "nellore").expansionBps).toBe(5_000);
    expect(resolveCityFinancePolicy(layers, "guntur").expansionBps).toBe(3_000);
  });
});

describe("break-even calculator", () => {
  it("reproduces the worked example: ₹18/order, ₹1,80,000 fixed, 600 orders a day, 40% expansion", () => {
    // Revenue ₹48 − costs ₹30 = ₹18 contribution.
    const result = breakEven({
      ordersPerDay: 600,
      averageOrderValuePaise: 30_000,
      commissionBps: 1_000,
      customerFeesPerOrderPaise: 1_800,
      riderCostPerOrderPaise: 2_500,
      promoCostPerOrderPaise: 500,
      paymentCostBps: 0,
      refundRateBps: 0,
      otherVariableCostPerOrderPaise: 0,
      fixedMonthlyCostPaise: 18_000_000,
      riskReserveBps: 0,
      workingCapitalReserveBps: 0,
      expansionBps: 4_000,
    });
    expect(result.contributionPerOrderPaise).toBe(1_800);
    expect(result.breakEvenOrdersPerMonth).toBe(10_000);
    expect(result.breakEvenOrdersPerDay).toBe(334);
    expect(result.monthlyContributionPaise).toBe(32_400_000);
    expect(result.monthlyOperatingProfitPaise).toBe(14_400_000);
    expect(result.monthlyExpansionPaise).toBe(5_760_000);
  });

  it("says there is no break-even when each order loses money", () => {
    const result = breakEven({
      ordersPerDay: 600, averageOrderValuePaise: 30_000, commissionBps: 500, customerFeesPerOrderPaise: 0,
      riderCostPerOrderPaise: 3_000, promoCostPerOrderPaise: 0, paymentCostBps: 0, refundRateBps: 0,
      otherVariableCostPerOrderPaise: 0, fixedMonthlyCostPaise: 18_000_000, riskReserveBps: 0,
      workingCapitalReserveBps: 0, expansionBps: 4_000,
    });
    expect(result.breakEvenOrdersPerDay).toBeNull();
    expect(result.monthlyExpansionPaise).toBe(0);
  });
});

describe("tax configuration readiness", () => {
  const versions = normalizeTaxVersions([
    {versionId: "legacy", mode: "legacy_flat_rate", effectiveFrom: 0, rules: []},
    {versionId: "ca-2026-10", mode: "component_rules", effectiveFrom: 1_000, approvedBy: "CA test", rules: [
      {component: "food", rateBps: 500, liableParty: "restaurant", collectedBy: "platform", discountTreatment: "after_discount"},
      {component: "platform_fee", rateBps: 1_800, liableParty: "platform", collectedBy: "platform"},
      {component: "delivery_fee", rateBps: 1_800, inclusive: true, liableParty: "platform"},
      {component: "commission", rateBps: 1_800, liableParty: "platform", collectedBy: "restaurant"},
    ]},
  ]);

  it("keeps the legacy flat rate until a CA-approved version is in force", () => {
    expect(activeTaxVersion(versions, 500)?.mode).toBe("legacy_flat_rate");
    expect(activeTaxVersion(versions, 2_000)?.versionId).toBe("ca-2026-10");
  });

  it("computes each component's tax, separating customer and restaurant tax", () => {
    const version = activeTaxVersion(versions, 2_000)!;
    const result = computeTaxLines(version, {
      foodPaise: 35_000, restaurantDiscountPaise: 5_000, platformDiscountPaise: 0, packagingPaise: 0,
      deliveryFeePaise: 2_950, platformFeePaise: 1_000, smallOrderFeePaise: 0, lateNightFeePaise: 0, surgeFeePaise: 0,
      rainFeePaise: 0, riderIncentiveFeePaise: 0, commissionPaise: 3_000,
    });
    const line = (component: string) => result.lines.find((entry) => entry.component === component);
    expect(line("food")).toMatchObject({basePaise: 30_000, taxPaise: 1_500});
    expect(line("platform_fee")?.taxPaise).toBe(180);
    expect(line("delivery_fee")).toMatchObject({inclusive: true, taxPaise: 450});
    expect(line("commission")?.taxPaise).toBe(540);
    // Inclusive tax is extracted for reporting, not added again.
    expect(result.customerTaxPaise).toBe(1_500 + 180);
    expect(result.restaurantTaxPaise).toBe(540);
  });
});
