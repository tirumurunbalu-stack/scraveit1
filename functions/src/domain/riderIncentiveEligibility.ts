import type {RiderRewardCampaign} from "../services/riderRewards";

// Deliberately self-contained (no service-level imports): services/riderRewards.ts
// pulls in ledger/notifications/auth/finance modules that several existing unit
// tests mock narrowly, and any new import edge into that file breaks those tests'
// module graphs. Only the RiderRewardCampaign *type* is imported above (type-only,
// erased at compile time - no runtime edge). The time-window matching logic below
// intentionally mirrors services/riderRewards.ts's private matchesTimeSlot/matchesDay
// exactly (same Intl.DateTimeFormat approach, same weekday numbering) so checkout-time
// and delivery-time matching stay in lockstep even though the code is duplicated.

const DEFAULT_TIMEZONE = "Asia/Kolkata";
// Safety backstop against a future data-entry mistake in a campaign's reward
// amount - mirrors the Math.min(500, ...) clamp loadServerFees already applies
// to rainFee.
const CHECKOUT_RIDER_INCENTIVE_MAX_PAISE = 10_000;

const WEEKDAY_INDEX: Record<string, number> = {sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6};

function safeTimeZone(value: string): string {
  const candidate = String(value || "").trim().slice(0, 80) || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: candidate}).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function zonedMinuteAndWeekday(referenceAt: number, timeZone: string): {minuteOfDay: number; weekday: number} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(referenceAt));
  const find = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(find("hour")) || 0;
  const minute = Number(find("minute")) || 0;
  const weekday = WEEKDAY_INDEX[find("weekday").slice(0, 3).toLowerCase()] ?? 0;
  return {minuteOfDay: hour * 60 + minute, weekday};
}

function matchesTimeSlot(startMinute: number, endMinute: number, minuteOfDay: number): boolean {
  return startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

function hasRiderSpecificTargeting(campaign: RiderRewardCampaign): boolean {
  return campaign.riderIds.length > 0 ||
    campaign.cityNames.length > 0 ||
    campaign.eligibleRiderTypes.length > 0 ||
    campaign.vehicleTypes.length > 0 ||
    campaign.minimumAccountAgeDays !== null ||
    campaign.minRating !== null ||
    campaign.minCompletedTrips !== null ||
    campaign.firstNCompletedTrips !== null ||
    campaign.requireDailyLoginSession;
}

function searchKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export interface CheckoutRiderIncentiveContext {
  restaurantId: string;
  area: string;
  subtotalPaise: number;
  rainFeeApplied: boolean;
}

/**
 * Mirrors deliveryMatchesCampaign's (services/riderRewards.ts) non-rider-specific
 * checks so a customer is only charged for a per-order bonus that will actually be
 * payable to whichever rider ends up delivering the order. No rider is assigned yet
 * at checkout time, so any campaign with rider-specific targeting (riderIds,
 * rating/trips/account-age minimums, the rider's own city, daily login sessions) is
 * excluded rather than guessed at - overcharging a customer for a bonus that might
 * not actually be paid out would be worse than not charging for it.
 */
export function checkoutEligibleRiderIncentiveCampaigns(
  campaigns: readonly RiderRewardCampaign[],
  now: number,
  ctx: CheckoutRiderIncentiveContext,
): readonly RiderRewardCampaign[] {
  return campaigns.filter((campaign) => {
    if (campaign.kind !== "per_order_bonus" || !campaign.rewardAmountPaise) return false;
    if (campaign.archived || !campaign.visible || !campaign.active) return false;
    if (now < campaign.startAt || now >= campaign.endAt) return false;
    if (hasRiderSpecificTargeting(campaign)) return false;
    const {minuteOfDay, weekday} = zonedMinuteAndWeekday(now, campaign.timezone);
    if (campaign.eligibleDays.length && !campaign.eligibleDays.includes(weekday)) return false;
    if (campaign.timeSlots.length && !campaign.timeSlots.some(
      (slot) => matchesTimeSlot(slot.startMinute, slot.endMinute, minuteOfDay),
    )) return false;
    if (campaign.restaurantIds.length && !campaign.restaurantIds.includes(ctx.restaurantId)) return false;
    if (campaign.zoneNames.length) {
      const area = searchKey(ctx.area);
      if (!campaign.zoneNames.some((name) => searchKey(name) === area)) return false;
    }
    if (campaign.orderTotalMinPaise !== null && ctx.subtotalPaise < campaign.orderTotalMinPaise) return false;
    if (campaign.rainOnly && !ctx.rainFeeApplied) return false;
    return true;
  });
}

/**
 * Same stacking rule evaluateRiderRewardsForDeliveredOrder (services/riderRewards.ts)
 * uses when a delivered order actually credits a rider: every "stack" match pays
 * independently, at most one "highest_only" match pays (highest amount, then
 * priority) - so the customer charge always equals what the platform will actually
 * end up paying out for this order.
 */
export function resolveCheckoutRiderIncentiveFeePaise(
  campaigns: readonly RiderRewardCampaign[],
): {amountPaise: number; campaignIds: string[]} {
  const stack = campaigns.filter((campaign) => campaign.stacking === "stack");
  const highestOnly = campaigns
    .filter((campaign) => campaign.stacking === "highest_only")
    .sort((left, right) => (right.rewardAmountPaise ?? 0) - (left.rewardAmountPaise ?? 0) || right.priority - left.priority);
  const chosen = highestOnly[0] ? [...stack, highestOnly[0]] : stack;
  const amountPaise = Math.min(
    CHECKOUT_RIDER_INCENTIVE_MAX_PAISE,
    chosen.reduce((total, campaign) => total + (campaign.rewardAmountPaise ?? 0), 0),
  );
  return {amountPaise, campaignIds: chosen.map((campaign) => campaign.campaignId)};
}

/**
 * Customer-facing label for a matched per-order bonus campaign, bucketed by
 * the time-of-day its (first) time slot starts. Deliberately distinct from
 * the pre-existing "Demand surge fee" (restaurant-workload based) and
 * "Estimated late-night fee" (settings/customer time-window based) checkout
 * rows - those are separate, independently-configured fees that can be
 * active at the same time as this one, so an identical label would make two
 * unrelated charges look like a duplicate-row bug.
 */
export function labelForRiderIncentiveCampaign(campaign: RiderRewardCampaign): string {
  const slot = campaign.timeSlots[0];
  if (!slot) return "Surge fee";
  const startHour = Math.floor(slot.startMinute / 60);
  if (startHour >= 21 || startHour === 0) return "Late-night surge fee";
  if (startHour >= 1 && startHour < 6) return "Early-morning fee";
  return "Surge fee";
}

export interface RiderIncentiveLineItem {
  label: string;
  amountPaise: number;
}

/**
 * Same selection as resolveCheckoutRiderIncentiveFeePaise, grouped into
 * customer-facing line items by label instead of a single combined figure -
 * each matched campaign shows under its own named fee (Surge fee /
 * Late-night surge fee / Early-morning fee) rather than one generic "rider
 * incentive" line.
 */
export function resolveCheckoutRiderIncentiveLineItems(
  campaigns: readonly RiderRewardCampaign[],
): readonly RiderIncentiveLineItem[] {
  const stack = campaigns.filter((campaign) => campaign.stacking === "stack");
  const highestOnly = campaigns
    .filter((campaign) => campaign.stacking === "highest_only")
    .sort((left, right) => (right.rewardAmountPaise ?? 0) - (left.rewardAmountPaise ?? 0) || right.priority - left.priority);
  const chosen = highestOnly[0] ? [...stack, highestOnly[0]] : stack;
  const totalsByLabel = new Map<string, number>();
  for (const campaign of chosen) {
    const label = labelForRiderIncentiveCampaign(campaign);
    totalsByLabel.set(label, (totalsByLabel.get(label) ?? 0) + (campaign.rewardAmountPaise ?? 0));
  }
  const combinedTotal = Array.from(totalsByLabel.values()).reduce((total, amount) => total + amount, 0);
  if (combinedTotal <= CHECKOUT_RIDER_INCENTIVE_MAX_PAISE || combinedTotal === 0) {
    return Array.from(totalsByLabel.entries()).map(([label, amountPaise]) => ({label, amountPaise}));
  }
  // Preserve the same overall safety ceiling as resolveCheckoutRiderIncentiveFeePaise
  // when scaling itemized amounts down proportionally.
  const scale = CHECKOUT_RIDER_INCENTIVE_MAX_PAISE / combinedTotal;
  return Array.from(totalsByLabel.entries()).map(([label, amountPaise]) => ({
    label,
    amountPaise: Math.round(amountPaise * scale),
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter(Boolean) : [];
}

function nullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return value != null && Number.isFinite(numeric) ? numeric : null;
}

/**
 * A light, checkout-scoped normalizer for the raw RTDB campaign record - reads
 * only the fields checkoutEligibleRiderIncentiveCampaigns/
 * resolveCheckoutRiderIncentiveFeePaise need, with the same safe defaults the
 * full production normalizer (normalizeRewardCampaign in services/riderRewards.ts)
 * applies. Deliberately not a full RiderRewardCampaign reconstruction - this file
 * cannot import that normalizer without reintroducing the heavy import edge this
 * module exists to avoid.
 */
export function normalizeCheckoutCampaign(campaignId: string, raw: unknown): RiderRewardCampaign | null {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!source) return null;
  const kind = source.kind === "per_order_bonus" ? "per_order_bonus" : "milestone_bonus";
  const rewardAmountPaise = nullableNumber(source.rewardAmountPaise);
  const timeSlots = Array.isArray(source.timeSlots)
    ? (source.timeSlots as unknown[])
      .map((entry) => {
        const slot = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        const startMinute = nullableNumber(slot.startMinute);
        const endMinute = nullableNumber(slot.endMinute);
        if (startMinute === null || endMinute === null) return null;
        return {label: String(slot.label ?? ""), startMinute, endMinute};
      })
      .filter((slot): slot is {label: string; startMinute: number; endMinute: number} => slot !== null)
    : [];
  return {
    schemaVersion: 1,
    campaignId,
    internalName: String(source.internalName ?? ""),
    title: String(source.title ?? ""),
    subtitle: String(source.subtitle ?? ""),
    description: String(source.description ?? ""),
    kind,
    displayType: (source.displayType as RiderRewardCampaign["displayType"]) ?? "special_campaign",
    section: (source.section as RiderRewardCampaign["section"]) ?? "special",
    rewardAmountPaise,
    milestones: [],
    window: (source.window as RiderRewardCampaign["window"]) ?? "daily",
    startAt: nullableNumber(source.startAt) ?? 0,
    endAt: nullableNumber(source.endAt) ?? 0,
    eligibleDays: Array.isArray(source.eligibleDays)
      ? (source.eligibleDays as unknown[]).map((day) => Number(day)).filter((day) => Number.isInteger(day))
      : [],
    timeSlots,
    cityNames: stringArray(source.cityNames),
    zoneNames: stringArray(source.zoneNames),
    restaurantIds: stringArray(source.restaurantIds),
    riderIds: stringArray(source.riderIds),
    minCompletedTrips: nullableNumber(source.minCompletedTrips),
    minRating: nullableNumber(source.minRating),
    firstNCompletedTrips: nullableNumber(source.firstNCompletedTrips),
    orderTotalMinPaise: nullableNumber(source.orderTotalMinPaise),
    rainOnly: source.rainOnly === true,
    requireDailyLoginSession: source.requireDailyLoginSession === true,
    minimumCompletedSessionsPerDay: nullableNumber(source.minimumCompletedSessionsPerDay),
    conditionGroups: [],
    otherConditions: [],
    milestonePayoutMode: (source.milestonePayoutMode as RiderRewardCampaign["milestonePayoutMode"]) ?? "highest_unlocked",
    timezone: String(source.timezone ?? DEFAULT_TIMEZONE),
    tripAttribution: "delivered_at",
    allowOverlappingSlotCredit: source.allowOverlappingSlotCredit === true,
    eligibleRiderTypes: stringArray(source.eligibleRiderTypes),
    vehicleTypes: stringArray(source.vehicleTypes),
    minimumAccountAgeDays: nullableNumber(source.minimumAccountAgeDays),
    stacking: source.stacking === "highest_only" ? "highest_only" : "stack",
    priority: nullableNumber(source.priority) ?? 100,
    visible: source.visible !== false,
    active: source.active !== false,
    archived: source.archived === true,
    updatedAt: nullableNumber(source.updatedAt) ?? 0,
    updatedBy: String(source.updatedBy ?? ""),
    updatedByRole: (source.updatedByRole as RiderRewardCampaign["updatedByRole"]) ?? "",
    lastOperationId: String(source.lastOperationId ?? ""),
  };
}
