/**
 * Rider trip pay - deliberately independent of what the customer is charged
 * for delivery. The customer's delivery fee is a price; the rider's trip pay
 * is a wage. The economics engine records both, and the difference between
 * them (a delivery subsidy or a delivery margin) is never hidden.
 *
 *   distance pay = base pickup pay
 *                + pickup rate × max(0, pickup km − included pickup km)
 *                + drop rate   × max(0, drop km − included drop km)
 *                + long-distance rate × max(0, drop km − long-distance threshold)
 *   distance pay × vehicle multiplier, then clamped to [minimum, maximum]
 *   trip pay = distance pay + waiting pay + time-slot pay
 *   waiting pay = min(cap, per-minute rate × max(0, wait minutes − free minutes))
 *
 * Rain, surge, peak and special bonuses stay in rider incentive campaigns;
 * tips are always passed through 100%.
 */

export interface RiderTripPaySlotAddon {
  label: string;
  startMinute: number;
  endMinute: number;
  amountPaise: number;
}

export interface RiderTripPayPolicy {
  basePickupPaise: number;
  includedPickupMeters: number;
  pickupPerKmPaise: number;
  includedDropMeters: number;
  dropPerKmPaise: number;
  longDistanceThresholdMeters: number;
  longDistancePerKmPaise: number;
  minimumTripPaise: number;
  /** 0 = no maximum. */
  maximumTripPaise: number;
  freeWaitMinutes: number;
  waitPerMinutePaise: number;
  maxWaitPaise: number;
  /** Used only for the checkout estimate, before a rider is assigned. */
  expectedPickupMeters: number;
  /** Late-night / early-morning pay built into the trip rate itself. */
  slotAddons: RiderTripPaySlotAddon[];
  /** e.g. {bicycle: 12000} pays bicycles 120% of distance pay. Missing = 100%. */
  vehicleMultiplierBps: Record<string, number>;
}

export const DEFAULT_RIDER_TRIP_PAY_POLICY: Readonly<RiderTripPayPolicy> = Object.freeze({
  basePickupPaise: 2_000,
  includedPickupMeters: 1_000,
  pickupPerKmPaise: 400,
  includedDropMeters: 2_000,
  dropPerKmPaise: 600,
  longDistanceThresholdMeters: 7_000,
  longDistancePerKmPaise: 300,
  minimumTripPaise: 2_500,
  maximumTripPaise: 0,
  freeWaitMinutes: 10,
  waitPerMinutePaise: 100,
  maxWaitPaise: 3_000,
  expectedPickupMeters: 1_500,
  slotAddons: [],
  vehicleMultiplierBps: {},
});

const NUMERIC_FIELDS: readonly (keyof RiderTripPayPolicy)[] = [
  "basePickupPaise", "includedPickupMeters", "pickupPerKmPaise", "includedDropMeters", "dropPerKmPaise",
  "longDistanceThresholdMeters", "longDistancePerKmPaise", "minimumTripPaise", "maximumTripPaise",
  "freeWaitMinutes", "waitPerMinutePaise", "maxWaitPaise", "expectedPickupMeters",
];
export const RIDER_TRIP_PAY_NUMERIC_FIELDS = NUMERIC_FIELDS;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function int(value: unknown, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.min(maximum, Math.max(minimum, parsed)));
}

function normalizeSlotAddons(value: unknown): RiderTripPaySlotAddon[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((entry) => {
    const input = record(entry);
    return {
      label: String(input.label ?? "Slot pay").slice(0, 60),
      startMinute: int(input.startMinute, 0, 1_439) ?? 0,
      endMinute: int(input.endMinute, 0, 1_439) ?? 0,
      amountPaise: int(input.amountPaise, 0, 100_000) ?? 0,
    };
  }).filter((entry) => entry.amountPaise > 0 && entry.startMinute !== entry.endMinute);
}

/** Keeps only valid fields - used for scoped, effective-dated overrides. */
export function normalizeRiderTripPayOverride(value: unknown): Partial<RiderTripPayPolicy> {
  const input = record(value);
  const output: Partial<RiderTripPayPolicy> = {};
  for (const field of NUMERIC_FIELDS) {
    const parsed = int(input[field], 0, 10_000_000);
    if (parsed !== null) (output as Record<string, number>)[field] = parsed;
  }
  if (Array.isArray(input.slotAddons)) output.slotAddons = normalizeSlotAddons(input.slotAddons);
  if (input.vehicleMultiplierBps && typeof input.vehicleMultiplierBps === "object") {
    const multipliers: Record<string, number> = {};
    for (const [vehicle, bps] of Object.entries(record(input.vehicleMultiplierBps))) {
      const key = String(vehicle).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
      const parsed = int(bps, 1_000, 30_000);
      if (key && parsed !== null) multipliers[key] = parsed;
    }
    output.vehicleMultiplierBps = multipliers;
  }
  return output;
}

export interface RiderTripPayVersion {
  effectiveFrom: number;
  /** 0 = open ended. */
  effectiveTo: number;
  label: string;
  override: Partial<RiderTripPayPolicy>;
}

export function normalizeRiderTripPayVersions(value: unknown): RiderTripPayVersion[] {
  const list = Array.isArray(value) ? value : [];
  return list.slice(0, 50).map((entry) => {
    const input = record(entry);
    return {
      effectiveFrom: int(input.effectiveFrom, 0, Number.MAX_SAFE_INTEGER) ?? 0,
      effectiveTo: int(input.effectiveTo, 0, Number.MAX_SAFE_INTEGER) ?? 0,
      label: String(input.label ?? "").slice(0, 80),
      override: normalizeRiderTripPayOverride(input.override),
    };
  }).filter((version) => Object.keys(version.override).length > 0)
    .sort((left, right) => left.effectiveFrom - right.effectiveFrom);
}

export interface RiderTripPayLayers {
  global: RiderTripPayVersion[];
  cities: Record<string, RiderTripPayVersion[]>;
  /** Keyed `${cityKey}|${zoneKey}`. */
  zones: Record<string, RiderTripPayVersion[]>;
}

function activeVersionOverride(versions: readonly RiderTripPayVersion[] | undefined, at: number): Partial<RiderTripPayPolicy> {
  const live = (versions ?? []).filter((version) =>
    version.effectiveFrom <= at && (version.effectiveTo === 0 || at < version.effectiveTo));
  return live.reduce<Partial<RiderTripPayPolicy>>((merged, version) => ({...merged, ...version.override}), {});
}

/** global -> city -> zone, each using only the versions in force at `at`. */
export function resolveRiderTripPayPolicy(
  layers: RiderTripPayLayers,
  scope: {cityKey: string; zoneKey: string},
  at: number,
  legacyMinimumTripPaise?: number,
): RiderTripPayPolicy {
  const base: RiderTripPayPolicy = {
    ...DEFAULT_RIDER_TRIP_PAY_POLICY,
    slotAddons: [],
    vehicleMultiplierBps: {},
    ...(legacyMinimumTripPaise !== undefined ? {minimumTripPaise: legacyMinimumTripPaise} : {}),
  };
  return {
    ...base,
    ...activeVersionOverride(layers.global, at),
    ...activeVersionOverride(layers.cities[scope.cityKey], at),
    ...(scope.zoneKey ? activeVersionOverride(layers.zones[`${scope.cityKey}|${scope.zoneKey}`], at) : {}),
  };
}

export interface RiderTripPayInput {
  pickupMeters: number;
  dropMeters: number;
  waitMinutes: number;
  /** Minute of the day (0-1439) in the city's timezone, for slot pay. */
  minuteOfDay: number;
  vehicleType?: string;
}

export interface RiderTripPayBreakdown {
  basePickupPaise: number;
  pickupDistancePaise: number;
  dropDistancePaise: number;
  longDistancePaise: number;
  vehicleAdjustmentPaise: number;
  minimumTopUpPaise: number;
  maximumCapPaise: number;
  waitingPaise: number;
  slotPaise: number;
  slotLabels: string[];
  totalPaise: number;
  pickupMeters: number;
  dropMeters: number;
  waitMinutes: number;
}

function perKm(meters: number, includedMeters: number, ratePaise: number): number {
  return Math.round(Math.max(0, meters - includedMeters) * ratePaise / 1_000);
}

function slotMatches(slot: RiderTripPaySlotAddon, minute: number): boolean {
  return slot.startMinute < slot.endMinute
    ? minute >= slot.startMinute && minute < slot.endMinute
    : minute >= slot.startMinute || minute < slot.endMinute;
}

export function calculateRiderTripPay(policy: RiderTripPayPolicy, input: RiderTripPayInput): RiderTripPayBreakdown {
  const pickupMeters = Math.max(0, Math.round(Number(input.pickupMeters) || 0));
  const dropMeters = Math.max(0, Math.round(Number(input.dropMeters) || 0));
  const waitMinutes = Math.max(0, Math.floor(Number(input.waitMinutes) || 0));
  const basePickupPaise = policy.basePickupPaise;
  const pickupDistancePaise = perKm(pickupMeters, policy.includedPickupMeters, policy.pickupPerKmPaise);
  const dropDistancePaise = perKm(dropMeters, policy.includedDropMeters, policy.dropPerKmPaise);
  const longDistancePaise = policy.longDistanceThresholdMeters > 0 ?
    perKm(dropMeters, policy.longDistanceThresholdMeters, policy.longDistancePerKmPaise) : 0;
  const rawDistance = basePickupPaise + pickupDistancePaise + dropDistancePaise + longDistancePaise;
  const vehicleKey = String(input.vehicleType ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const multiplier = policy.vehicleMultiplierBps[vehicleKey] ?? 10_000;
  const vehicleAdjusted = Math.round(rawDistance * multiplier / 10_000);
  const vehicleAdjustmentPaise = vehicleAdjusted - rawDistance;
  const minimumTopUpPaise = Math.max(0, policy.minimumTripPaise - vehicleAdjusted);
  const afterMinimum = vehicleAdjusted + minimumTopUpPaise;
  const maximumCapPaise = policy.maximumTripPaise > 0 ? Math.max(0, afterMinimum - policy.maximumTripPaise) : 0;
  const distancePay = afterMinimum - maximumCapPaise;
  const waitingPaise = Math.min(
    policy.maxWaitPaise,
    Math.max(0, waitMinutes - policy.freeWaitMinutes) * policy.waitPerMinutePaise,
  );
  const minute = Math.max(0, Math.min(1_439, Math.floor(Number(input.minuteOfDay) || 0)));
  const slots = policy.slotAddons.filter((slot) => slotMatches(slot, minute));
  const slotPaise = slots.reduce((total, slot) => total + slot.amountPaise, 0);
  return {
    basePickupPaise,
    pickupDistancePaise,
    dropDistancePaise,
    longDistancePaise,
    vehicleAdjustmentPaise,
    minimumTopUpPaise,
    maximumCapPaise,
    waitingPaise,
    slotPaise,
    slotLabels: slots.map((slot) => slot.label),
    totalPaise: distancePay + waitingPaise + slotPaise,
    pickupMeters,
    dropMeters,
    waitMinutes,
  };
}

export function minuteOfDayInTimeZone(at: number, timeZone = "Asia/Kolkata"): number {
  const parts = new Intl.DateTimeFormat("en-US", {timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"})
    .formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}
