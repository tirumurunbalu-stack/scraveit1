import {describe, expect, it} from "vitest";
import {
  DEFAULT_COD_OUTSTANDING_LIMIT_PAISE,
  DEFAULT_FINANCE_POLICY,
  financePayoutAutomationSummary,
  normalizeFinancePolicy,
  selectFinancePayoutMethodForAutomation,
} from "../src/domain/financePolicy";

describe("finance policy", () => {
  it("preserves the 15% commission and defaults COD exposure to a finite INR 5,000", () => {
    expect(normalizeFinancePolicy(null)).toEqual(DEFAULT_FINANCE_POLICY);
    expect(DEFAULT_FINANCE_POLICY.codOutstandingLimitPaise).toBe(DEFAULT_COD_OUTSTANDING_LIMIT_PAISE);
    expect(DEFAULT_COD_OUTSTANDING_LIMIT_PAISE).toBe(500_000);
  });

  it("normalizes backend-controlled values and rejects dangerous ranges", () => {
    expect(normalizeFinancePolicy({restaurantCommissionBps: 1_250, codOutstandingLimitPaise: 500_000}))
      .toMatchObject({restaurantCommissionBps: 1_250, codOutstandingLimitPaise: 500_000});
    expect(normalizeFinancePolicy({restaurantCommissionBps: 99_999, codOutstandingLimitPaise: -1}))
      .toMatchObject({restaurantCommissionBps: 5_000, codOutstandingLimitPaise: 0});
    expect(normalizeFinancePolicy({codOutstandingLimitPaise: 0}))
      .toMatchObject({codOutstandingLimitPaise: 0});
  });

  it("derives the weekly payout schedule and current period in the configured timezone", () => {
    const policy = normalizeFinancePolicy({
      payouts: {
        automation: {
          enabled: true,
          timezone: "Asia/Kolkata",
          executionDayOfWeek: 1,
          executionMinuteOfDay: 10 * 60 + 30,
        },
      },
    });
    const summary = financePayoutAutomationSummary(policy, Date.parse("2026-08-25T06:00:00.000Z"));
    expect(summary).toMatchObject({
      enabled: true,
      scheduleLabel: "Monday 10:30 AM (Asia/Kolkata)",
      currentPeriodKey: "2026-08-24",
      nextRunDayKey: "2026-08-31",
    });
  });

  it("prefers UPI below the threshold and bank rails above it", () => {
    const policy = normalizeFinancePolicy({
      payouts: {
        upiPreferredMaximumPaise: 100_000,
        highValuePayoutMethod: "neft",
        upiEnabled: true,
        impsEnabled: true,
        neftEnabled: true,
      },
    });
    expect(selectFinancePayoutMethodForAutomation(policy, 50_000, {
      preferredMethod: "upi",
      upiReady: true,
      bankReady: true,
    })).toEqual({method: "upi", blockedReason: null});
    expect(selectFinancePayoutMethodForAutomation(policy, 250_000, {
      preferredMethod: "upi",
      upiReady: true,
      bankReady: true,
    })).toEqual({method: "neft", blockedReason: null});
  });
});
