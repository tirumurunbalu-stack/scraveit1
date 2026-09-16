import {describe, expect, it} from "vitest";
import type {RiderRewardCampaign} from "../services/riderRewards";
import {
  checkoutEligibleRiderIncentiveCampaigns,
  labelForRiderIncentiveCampaign,
  resolveCheckoutRiderIncentiveFeePaise,
  resolveCheckoutRiderIncentiveLineItems,
} from "./riderIncentiveEligibility";

function at(localDateTime: string): number {
  return Date.parse(`${localDateTime}+05:30`);
}

function minute(value: string): number {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function campaign(overrides: Partial<RiderRewardCampaign> = {}): RiderRewardCampaign {
  return {
    schemaVersion: 1,
    campaignId: "weekly-extra",
    internalName: "Weekly Extra",
    title: "Weekly Extra",
    subtitle: "",
    description: "",
    kind: "milestone_bonus",
    displayType: "weekly_incentive",
    section: "special",
    rewardAmountPaise: null,
    milestones: [{target: 2, rewardAmountPaise: 5_000, label: "2 trips"}],
    window: "custom",
    startAt: at("2026-08-26T00:00:00"),
    endAt: at("2026-08-27T00:00:00"),
    eligibleDays: [],
    timeSlots: [],
    cityNames: [],
    zoneNames: [],
    restaurantIds: [],
    riderIds: [],
    minCompletedTrips: null,
    minRating: null,
    firstNCompletedTrips: null,
    orderTotalMinPaise: null,
    rainOnly: false,
    requireDailyLoginSession: false,
    minimumCompletedSessionsPerDay: null,
    conditionGroups: [],
    otherConditions: [],
    milestonePayoutMode: "highest_unlocked",
    timezone: "Asia/Kolkata",
    tripAttribution: "delivered_at",
    allowOverlappingSlotCredit: false,
    eligibleRiderTypes: [],
    vehicleTypes: [],
    minimumAccountAgeDays: null,
    stacking: "stack",
    priority: 100,
    visible: true,
    active: true,
    archived: false,
    updatedAt: at("2026-08-20T12:00:00"),
    updatedBy: "admin_test",
    updatedByRole: "owner",
    lastOperationId: "seed_campaign",
    ...overrides,
  };
}

describe("checkout rider incentive fee (customer checkout mirror of per-order bonuses)", () => {
  // A Wednesday, well inside every fixture's active window, used as "now".
  const lunchNow = at("2026-08-26T13:00:00");

  function perOrderBonus(overrides: Partial<RiderRewardCampaign> = {}): RiderRewardCampaign {
    return campaign({
      kind: "per_order_bonus",
      rewardAmountPaise: 1_000,
      milestones: [],
      window: "daily",
      startAt: at("2026-08-01T00:00:00"),
      endAt: at("2026-12-01T00:00:00"),
      eligibleDays: [],
      timeSlots: [{label: "Lunch", startMinute: minute("12:00"), endMinute: minute("15:00")}],
      ...overrides,
    });
  }

  const ctx = {restaurantId: "rest-1", area: "Naidupeta", subtotalPaise: 20_000, rainFeeApplied: false};

  it("matches a campaign whose time slot covers now", () => {
    const [match] = checkoutEligibleRiderIncentiveCampaigns([perOrderBonus()], lunchNow, ctx);
    expect(match?.campaignId).toBe("weekly-extra");
  });

  it("does not match outside the time slot", () => {
    const outside = at("2026-08-26T20:00:00");
    expect(checkoutEligibleRiderIncentiveCampaigns([perOrderBonus()], outside, ctx)).toHaveLength(0);
  });

  it("handles a midnight-wraparound slot (late-night 11pm-2am)", () => {
    const lateNight = perOrderBonus({
      campaignId: "late-night",
      timeSlots: [{label: "Late night", startMinute: minute("23:00"), endMinute: minute("02:00")}],
    });
    expect(checkoutEligibleRiderIncentiveCampaigns([lateNight], at("2026-08-26T00:30:00"), ctx)).toHaveLength(1);
    expect(checkoutEligibleRiderIncentiveCampaigns([lateNight], at("2026-08-26T23:30:00"), ctx)).toHaveLength(1);
    expect(checkoutEligibleRiderIncentiveCampaigns([lateNight], at("2026-08-26T15:00:00"), ctx)).toHaveLength(0);
  });

  it("excludes a day the campaign is not eligible on", () => {
    // 2026-08-26 is a Wednesday (weekday 3); exclude it explicitly.
    const weekdayLimited = perOrderBonus({eligibleDays: [0, 1, 2, 4, 5, 6]});
    expect(checkoutEligibleRiderIncentiveCampaigns([weekdayLimited], lunchNow, ctx)).toHaveLength(0);
  });

  it("respects restaurantIds targeting", () => {
    const targeted = perOrderBonus({restaurantIds: ["rest-2"]});
    expect(checkoutEligibleRiderIncentiveCampaigns([targeted], lunchNow, ctx)).toHaveLength(0);
    expect(checkoutEligibleRiderIncentiveCampaigns(
      [perOrderBonus({restaurantIds: ["rest-1"]})], lunchNow, ctx,
    )).toHaveLength(1);
  });

  it("respects zoneNames targeting against the order's area", () => {
    const targeted = perOrderBonus({zoneNames: ["Sullurpeta"]});
    expect(checkoutEligibleRiderIncentiveCampaigns([targeted], lunchNow, ctx)).toHaveLength(0);
    expect(checkoutEligibleRiderIncentiveCampaigns(
      [perOrderBonus({zoneNames: ["Naidupeta"]})], lunchNow, ctx,
    )).toHaveLength(1);
  });

  it("respects orderTotalMinPaise against the order subtotal", () => {
    const highMinimum = perOrderBonus({orderTotalMinPaise: 50_000});
    expect(checkoutEligibleRiderIncentiveCampaigns([highMinimum], lunchNow, ctx)).toHaveLength(0);
    expect(checkoutEligibleRiderIncentiveCampaigns(
      [highMinimum], lunchNow, {...ctx, subtotalPaise: 60_000},
    )).toHaveLength(1);
  });

  it("gates a rainOnly campaign on whether the rain fee actually applied", () => {
    const rainOnly = perOrderBonus({rainOnly: true});
    expect(checkoutEligibleRiderIncentiveCampaigns([rainOnly], lunchNow, ctx)).toHaveLength(0);
    expect(checkoutEligibleRiderIncentiveCampaigns(
      [rainOnly], lunchNow, {...ctx, rainFeeApplied: true},
    )).toHaveLength(1);
  });

  it("never charges for a milestone_bonus campaign", () => {
    const milestone = perOrderBonus({kind: "milestone_bonus", rewardAmountPaise: null, milestones: [{target: 5, rewardAmountPaise: 5_000, label: "5 trips"}]});
    expect(checkoutEligibleRiderIncentiveCampaigns([milestone], lunchNow, ctx)).toHaveLength(0);
  });

  it("excludes archived, invisible, or inactive campaigns", () => {
    expect(checkoutEligibleRiderIncentiveCampaigns([perOrderBonus({archived: true})], lunchNow, ctx)).toHaveLength(0);
    expect(checkoutEligibleRiderIncentiveCampaigns([perOrderBonus({visible: false})], lunchNow, ctx)).toHaveLength(0);
    expect(checkoutEligibleRiderIncentiveCampaigns([perOrderBonus({active: false})], lunchNow, ctx)).toHaveLength(0);
  });

  it.each([
    ["riderIds", {riderIds: ["rider_1"]}],
    ["cityNames", {cityNames: ["Nellore"]}],
    ["eligibleRiderTypes", {eligibleRiderTypes: ["gold"]}],
    ["vehicleTypes", {vehicleTypes: ["bike"]}],
    ["minimumAccountAgeDays", {minimumAccountAgeDays: 30}],
    ["minRating", {minRating: 4.5}],
    ["minCompletedTrips", {minCompletedTrips: 10}],
    ["firstNCompletedTrips", {firstNCompletedTrips: 50}],
    ["requireDailyLoginSession", {requireDailyLoginSession: true}],
  ] as const)(
    "excludes an otherwise-matching campaign that has rider-specific targeting (%s) - no rider is assigned yet at checkout",
    (_label, overrides) => {
      expect(checkoutEligibleRiderIncentiveCampaigns([perOrderBonus(overrides)], lunchNow, ctx)).toHaveLength(0);
    },
  );

  it("sums every stack-mode match independently", () => {
    const a = perOrderBonus({campaignId: "a", rewardAmountPaise: 1_000, stacking: "stack"});
    const b = perOrderBonus({campaignId: "b", rewardAmountPaise: 1_500, stacking: "stack"});
    const result = resolveCheckoutRiderIncentiveFeePaise([a, b]);
    expect(result.amountPaise).toBe(2_500);
    expect(result.campaignIds.sort()).toEqual(["a", "b"]);
  });

  it("keeps only the highest-amount highest_only match", () => {
    const low = perOrderBonus({campaignId: "low", rewardAmountPaise: 1_000, stacking: "highest_only", priority: 100});
    const high = perOrderBonus({campaignId: "high", rewardAmountPaise: 2_000, stacking: "highest_only", priority: 100});
    const result = resolveCheckoutRiderIncentiveFeePaise([low, high]);
    expect(result.amountPaise).toBe(2_000);
    expect(result.campaignIds).toEqual(["high"]);
  });

  it("breaks a highest_only tie on priority", () => {
    const lowPriority = perOrderBonus({campaignId: "low-pri", rewardAmountPaise: 1_000, stacking: "highest_only", priority: 100});
    const highPriority = perOrderBonus({campaignId: "high-pri", rewardAmountPaise: 1_000, stacking: "highest_only", priority: 200});
    const result = resolveCheckoutRiderIncentiveFeePaise([lowPriority, highPriority]);
    expect(result.campaignIds).toEqual(["high-pri"]);
  });

  it("combines every stack match with the best highest_only match", () => {
    const stackA = perOrderBonus({campaignId: "stack-a", rewardAmountPaise: 1_000, stacking: "stack"});
    const bestOnly = perOrderBonus({campaignId: "best-only", rewardAmountPaise: 3_000, stacking: "highest_only", priority: 200});
    const worseOnly = perOrderBonus({campaignId: "worse-only", rewardAmountPaise: 1_000, stacking: "highest_only", priority: 100});
    const result = resolveCheckoutRiderIncentiveFeePaise([stackA, bestOnly, worseOnly]);
    expect(result.amountPaise).toBe(4_000);
    expect(result.campaignIds.sort()).toEqual(["best-only", "stack-a"]);
  });

  it("clamps the combined fee to the safety ceiling", () => {
    const campaigns = Array.from({length: 20}, (_, index) =>
      perOrderBonus({campaignId: `stack-${index}`, rewardAmountPaise: 1_000, stacking: "stack"}));
    const result = resolveCheckoutRiderIncentiveFeePaise(campaigns);
    expect(result.amountPaise).toBe(10_000);
  });

  it("returns zero for no matching campaigns", () => {
    const result = resolveCheckoutRiderIncentiveFeePaise([]);
    expect(result.amountPaise).toBe(0);
    expect(result.campaignIds).toEqual([]);
  });

  it("labels each of the four live production campaign windows correctly", () => {
    // Mirrors the real campaigns currently in production (functions/src/domain
    // /riderIncentiveEligibility.ts's label buckets are derived from these).
    expect(labelForRiderIncentiveCampaign(perOrderBonus({
      timeSlots: [{label: "Early morning", startMinute: minute("02:00"), endMinute: minute("06:00")}],
    }))).toBe("Early-morning fee");
    expect(labelForRiderIncentiveCampaign(perOrderBonus({
      timeSlots: [{label: "Late night", startMinute: minute("23:00"), endMinute: minute("02:00")}],
    }))).toBe("Late-night surge fee");
    expect(labelForRiderIncentiveCampaign(perOrderBonus({
      timeSlots: [{label: "Lunch", startMinute: minute("12:00"), endMinute: minute("15:00")}],
    }))).toBe("Surge fee");
    expect(labelForRiderIncentiveCampaign(perOrderBonus({
      timeSlots: [{label: "Snacks", startMinute: minute("17:00"), endMinute: minute("19:00")}],
    }))).toBe("Surge fee");
  });

  it("falls back to Surge fee for a campaign with no time slots", () => {
    expect(labelForRiderIncentiveCampaign(perOrderBonus({timeSlots: []}))).toBe("Surge fee");
  });

  it("groups line items by label and sums same-label matches", () => {
    const morning = perOrderBonus({
      campaignId: "morning", rewardAmountPaise: 1_000,
      timeSlots: [{label: "Early morning", startMinute: minute("02:00"), endMinute: minute("06:00")}],
    });
    const lunch = perOrderBonus({
      campaignId: "lunch", rewardAmountPaise: 1_000,
      timeSlots: [{label: "Lunch", startMinute: minute("12:00"), endMinute: minute("15:00")}],
    });
    const snacks = perOrderBonus({
      campaignId: "snacks", rewardAmountPaise: 1_500,
      timeSlots: [{label: "Snacks", startMinute: minute("17:00"), endMinute: minute("19:00")}],
    });
    const items = resolveCheckoutRiderIncentiveLineItems([morning, lunch, snacks]);
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.label === "Early-morning fee")?.amountPaise).toBe(1_000);
    expect(items.find((item) => item.label === "Surge fee")?.amountPaise).toBe(2_500);
  });

  it("returns no line items when nothing matches", () => {
    expect(resolveCheckoutRiderIncentiveLineItems([])).toEqual([]);
  });
});
