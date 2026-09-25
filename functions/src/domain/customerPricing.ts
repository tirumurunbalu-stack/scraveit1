/**
 * City- and zone-level customer pricing overrides, layered over the global
 * `settings/customer` document that checkout already reads. Customer pricing
 * is a price list; it never decides what a rider is paid.
 */

export interface DeliverySlab {
  maxKm: number;
  feePaise: number;
}

export interface CustomerPricingOverride {
  deliverySlabs?: DeliverySlab[];
  freeDeliveryAbovePaise?: number;
  platformFeePaise?: number;
  smallOrderThresholdPaise?: number;
  smallOrderFeePaise?: number;
  lateNightFeePaise?: number;
  surgeEnabled?: boolean;
  surgeLowFeePaise?: number;
  surgeMediumFeePaise?: number;
  surgeHighFeePaise?: number;
  rainFeeEnabled?: boolean;
  maxDeliveryKm?: number;
  minimumOrderPaise?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const PAISE_FIELDS = [
  "freeDeliveryAbovePaise", "platformFeePaise", "smallOrderThresholdPaise", "smallOrderFeePaise",
  "lateNightFeePaise", "surgeLowFeePaise", "surgeMediumFeePaise", "surgeHighFeePaise", "minimumOrderPaise",
] as const;

export function normalizeCustomerPricingOverride(value: unknown): CustomerPricingOverride {
  const input = record(value);
  const output: CustomerPricingOverride = {};
  for (const field of PAISE_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === "") continue;
    const parsed = Number(input[field]);
    if (Number.isFinite(parsed) && parsed >= 0) output[field] = Math.round(Math.min(10_000_000, parsed));
  }
  if (typeof input.surgeEnabled === "boolean") output.surgeEnabled = input.surgeEnabled;
  if (typeof input.rainFeeEnabled === "boolean") output.rainFeeEnabled = input.rainFeeEnabled;
  if (input.maxDeliveryKm !== undefined && input.maxDeliveryKm !== null && input.maxDeliveryKm !== "") {
    const parsed = Number(input.maxDeliveryKm);
    if (Number.isFinite(parsed) && parsed > 0) output.maxDeliveryKm = Math.min(100, parsed);
  }
  if (Array.isArray(input.deliverySlabs)) {
    const slabs = input.deliverySlabs.map((entry) => {
      const slab = record(entry);
      return {maxKm: Number(slab.maxKm), feePaise: Math.round(Number(slab.feePaise))};
    }).filter((slab) => Number.isFinite(slab.maxKm) && slab.maxKm > 0 && Number.isFinite(slab.feePaise) && slab.feePaise >= 0)
      .sort((left, right) => left.maxKm - right.maxKm)
      .slice(0, 20);
    if (slabs.length) output.deliverySlabs = slabs;
  }
  return output;
}

export function resolveCustomerPricing(
  layers: {cities?: Record<string, CustomerPricingOverride>; zones?: Record<string, CustomerPricingOverride>},
  cityKey: string,
  zoneKey: string,
): {override: CustomerPricingOverride; scopes: string[]} {
  const scopes: string[] = [];
  let override: CustomerPricingOverride = {};
  const city = layers.cities?.[cityKey];
  if (city && Object.keys(city).length) {
    override = {...override, ...city};
    scopes.push(`city:${cityKey}`);
  }
  const zone = zoneKey ? layers.zones?.[`${cityKey}|${zoneKey}`] : undefined;
  if (zone && Object.keys(zone).length) {
    override = {...override, ...zone};
    scopes.push(`zone:${cityKey}|${zoneKey}`);
  }
  return {override, scopes};
}

/**
 * Applies an override to the legacy settings record (rupee fields), so the
 * rest of loadServerFees keeps reading the fields it always has.
 */
export function applyCustomerPricingOverride(
  settings: Record<string, unknown>,
  override: CustomerPricingOverride,
): Record<string, unknown> {
  const next: Record<string, unknown> = {...settings};
  const rupees = (paise: number) => paise / 100;
  if (override.deliverySlabs) next.deliverySlabs = override.deliverySlabs.map((slab) => ({maxKm: slab.maxKm, fee: rupees(slab.feePaise)}));
  if (override.freeDeliveryAbovePaise !== undefined) next.freeDeliveryAbove = rupees(override.freeDeliveryAbovePaise);
  if (override.platformFeePaise !== undefined) next.platformFee = rupees(override.platformFeePaise);
  if (override.smallOrderThresholdPaise !== undefined) next.smallOrderThreshold = rupees(override.smallOrderThresholdPaise);
  if (override.smallOrderFeePaise !== undefined) next.smallOrderFee = rupees(override.smallOrderFeePaise);
  if (override.lateNightFeePaise !== undefined) next.lateNightFee = rupees(override.lateNightFeePaise);
  if (override.surgeEnabled !== undefined) next.surgeEnabled = override.surgeEnabled;
  if (override.surgeLowFeePaise !== undefined) next.surgeLowFee = rupees(override.surgeLowFeePaise);
  if (override.surgeMediumFeePaise !== undefined) next.surgeMediumFee = rupees(override.surgeMediumFeePaise);
  if (override.surgeHighFeePaise !== undefined) next.surgeHighFee = rupees(override.surgeHighFeePaise);
  if (override.rainFeeEnabled !== undefined) next.rainFeeEnabled = override.rainFeeEnabled;
  if (override.maxDeliveryKm !== undefined) next.maxDeliveryKm = override.maxDeliveryKm;
  if (override.minimumOrderPaise !== undefined) next.minimumOrder = rupees(override.minimumOrderPaise);
  return next;
}

// ---------------------------------------------------------------------------
// Customer referral programme
// ---------------------------------------------------------------------------

export interface CustomerReferralProgram {
  active: boolean;
  referrerRewardPaise: number;
  refereeRewardPaise: number;
  /** Delivered orders the new customer needs before anyone is rewarded. */
  minDeliveredOrders: number;
  minOrderValuePaise: number;
  rewardExpiryDays: number;
  /** A referral that does not qualify within this many days lapses. */
  qualifyWithinDays: number;
  budgetPaise: number;
  cityKeys: string[];
  startsAt: number;
  endsAt: number;
  /** Off by default: signup alone never earns money. */
  rewardOnSignup: boolean;
  /** Referrals with fraud signals wait for an admin unless this is on. */
  autoApproveFlagged: boolean;
}

export const DEFAULT_CUSTOMER_REFERRAL_PROGRAM: Readonly<CustomerReferralProgram> = Object.freeze({
  active: false,
  referrerRewardPaise: 5_000,
  refereeRewardPaise: 5_000,
  minDeliveredOrders: 1,
  minOrderValuePaise: 19_900,
  rewardExpiryDays: 30,
  qualifyWithinDays: 30,
  budgetPaise: 0,
  cityKeys: [],
  startsAt: 0,
  endsAt: 0,
  rewardOnSignup: false,
  autoApproveFlagged: false,
});

export function normalizeCustomerReferralProgram(value: unknown): CustomerReferralProgram {
  const input = record(value);
  const int = (entry: unknown, fallback: number, max = 1_000_000_000_00) => {
    const parsed = Number(entry);
    return Number.isFinite(parsed) ? Math.round(Math.min(max, Math.max(0, parsed))) : fallback;
  };
  const d = DEFAULT_CUSTOMER_REFERRAL_PROGRAM;
  return {
    active: typeof input.active === "boolean" ? input.active : d.active,
    referrerRewardPaise: int(input.referrerRewardPaise, d.referrerRewardPaise, 10_000_000),
    refereeRewardPaise: int(input.refereeRewardPaise, d.refereeRewardPaise, 10_000_000),
    minDeliveredOrders: Math.max(1, int(input.minDeliveredOrders, d.minDeliveredOrders, 100)),
    minOrderValuePaise: int(input.minOrderValuePaise, d.minOrderValuePaise, 10_000_000),
    rewardExpiryDays: Math.max(1, int(input.rewardExpiryDays, d.rewardExpiryDays, 3_650)),
    qualifyWithinDays: Math.max(1, int(input.qualifyWithinDays, d.qualifyWithinDays, 3_650)),
    budgetPaise: int(input.budgetPaise, d.budgetPaise),
    cityKeys: Array.isArray(input.cityKeys) ?
      input.cityKeys.map((key) => String(key).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean) : [],
    startsAt: int(input.startsAt, 0, Number.MAX_SAFE_INTEGER),
    endsAt: int(input.endsAt, 0, Number.MAX_SAFE_INTEGER),
    rewardOnSignup: input.rewardOnSignup === true,
    autoApproveFlagged: input.autoApproveFlagged === true,
  };
}

export function customerReferralProgramOpen(program: CustomerReferralProgram, cityKey: string, at: number): boolean {
  if (!program.active) return false;
  if (program.startsAt && at < program.startsAt) return false;
  if (program.endsAt && at >= program.endsAt) return false;
  return program.cityKeys.length === 0 || program.cityKeys.includes(cityKey);
}

export interface ReferralRiskSignals {
  sameDevice: boolean;
  samePhone: boolean;
  nearbyAddress: boolean;
  deviceUsedByOtherReferral: boolean;
  samePaymentAccount: boolean;
}

export function referralRiskFlags(signals: ReferralRiskSignals): string[] {
  return (Object.keys(signals) as (keyof ReferralRiskSignals)[]).filter((key) => signals[key]);
}

/** Whether this delivered order makes a pending referral qualify. */
export function referralQualifies(input: {
  program: CustomerReferralProgram;
  deliveredOrders: number;
  orderSubtotalPaise: number;
  appliedAt: number;
  at: number;
}): boolean {
  if (input.at - input.appliedAt > input.program.qualifyWithinDays * 86_400_000) return false;
  return input.deliveredOrders >= input.program.minDeliveredOrders &&
    input.orderSubtotalPaise >= input.program.minOrderValuePaise;
}
