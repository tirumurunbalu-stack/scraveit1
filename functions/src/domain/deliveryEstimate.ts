/**
 * Server-computed delivery time estimate.
 *
 * Every order previously quoted the restaurant's stored etaMin/etaMax, so a
 * 400 m order and a 9 km order in the middle of the dinner rush promised the
 * same time. That single number is the thing customers judge a delivery
 * platform on, so it is computed here from the conditions that actually move
 * it: how far the food has to travel, how loaded the kitchen is right now,
 * whether a rider is free to collect it, and whether it is peak hour.
 *
 * The restaurant's own etaMin/etaMax is still the starting point - the kitchen
 * knows its food better than this module does - but it is now treated as the
 * prep estimate it really is, not as the whole door-to-door promise.
 *
 * Deliberately pure: no clock, no database, no config reads. Everything it
 * needs is passed in, so the whole estimator is testable and so a bad signal
 * degrades predictably rather than throwing inside order creation.
 */

/** Door-to-door two-wheeler average for the towns this runs in, including
 *  junctions and stops - not open-road speed. Tunable in one place. */
const AVERAGE_RIDER_SPEED_KMPH = 22;

/** Collecting from the counter plus finding the customer at the other end.
 *  Independent of distance, which is why it is added rather than scaled. */
const HANDOVER_OVERHEAD_MINUTES = 5;

/** A kitchen absorbs a few concurrent orders without slowing down. Past this
 *  each additional live order starts pushing prep time out. */
const KITCHEN_FREE_CONCURRENCY = 3;
const MINUTES_PER_BACKED_UP_ORDER = 1.5;
const MAX_KITCHEN_LOAD_MINUTES = 20;

/** When nobody is free to collect, the food waits on the counter. */
const NO_RIDER_WAIT_MINUTES = 8;
const SCARCE_RIDER_WAIT_MINUTES = 3;
const SCARCE_RIDER_THRESHOLD = 2;

const PEAK_MINUTES = 4;
const IST_OFFSET_MINUTES = 330;

/** Lunch and dinner rushes in local time, as [startHour, endHour) in decimals. */
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [12, 14.5],
  [19, 21.5],
];

/** Absolute guard rails. A quote outside these is a bug, not a slow day. */
const MIN_ETA_MINUTES = 10;
const MAX_ETA_MINUTES = 120;

/** The quoted window never collapses to a point and never becomes useless. */
const MIN_SPREAD_MINUTES = 5;
const MAX_SPREAD_MINUTES = 20;

export type EstimateConfidence = "high" | "medium" | "low";

export interface DeliveryEstimateInput {
  /** The restaurant's own prep estimate. Treated as prep only, not door-to-door. */
  readonly kitchenEtaMinMinutes: unknown;
  readonly kitchenEtaMaxMinutes: unknown;
  readonly distanceKm: unknown;
  /** Live concurrent orders at this restaurant. */
  readonly activeOrders: unknown;
  /** Riders online, fresh and unassigned nearby. `null` means "could not be
   *  determined" - which must not be punished as if it were zero. */
  readonly availableRiders: number | null;
  readonly occurredAt: number;
}

export interface DeliveryEstimateBasis {
  readonly prepMinMinutes: number;
  readonly prepMaxMinutes: number;
  readonly travelMinutes: number;
  readonly kitchenLoadMinutes: number;
  readonly riderWaitMinutes: number;
  readonly peakMinutes: number;
  readonly distanceKm: number;
  readonly activeOrders: number;
  readonly availableRiders: number | null;
}

export interface DeliveryEstimate {
  readonly etaMinMinutes: number;
  readonly etaMaxMinutes: number;
  readonly confidence: EstimateConfidence;
  readonly basis: DeliveryEstimateBasis;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * A restaurant that has never set a prep time, or has stored something absurd,
 * must not be able to produce a nonsense promise. Falls back to a plain
 * 15-25 minute kitchen rather than trusting bad catalogue data.
 */
function prepWindow(minValue: unknown, maxValue: unknown): {min: number; max: number} {
  const rawMin = finiteNumber(minValue, 0);
  const rawMax = finiteNumber(maxValue, 0);
  const min = rawMin > 0 ? bounded(rawMin, 3, 90) : 15;
  const max = rawMax > 0 ? bounded(rawMax, 3, 90) : Math.max(min + 10, 25);
  return max >= min ? {min, max} : {min: max, max: min};
}

function travelMinutes(distanceKm: number): number {
  if (distanceKm <= 0) return HANDOVER_OVERHEAD_MINUTES;
  return (distanceKm / AVERAGE_RIDER_SPEED_KMPH) * 60 + HANDOVER_OVERHEAD_MINUTES;
}

function kitchenLoadMinutes(activeOrders: number): number {
  const backedUp = Math.max(0, activeOrders - KITCHEN_FREE_CONCURRENCY);
  return Math.min(MAX_KITCHEN_LOAD_MINUTES, backedUp * MINUTES_PER_BACKED_UP_ORDER);
}

function riderWaitMinutes(availableRiders: number | null): number {
  if (availableRiders === null) return 0;
  if (availableRiders <= 0) return NO_RIDER_WAIT_MINUTES;
  if (availableRiders <= SCARCE_RIDER_THRESHOLD) return SCARCE_RIDER_WAIT_MINUTES;
  return 0;
}

/** Local wall-clock hour in IST. India has no DST, so a fixed offset is exact. */
export function localHourOfDay(occurredAt: number): number {
  const shifted = new Date(occurredAt + IST_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
}

export function isPeakHour(occurredAt: number): boolean {
  const hour = localHourOfDay(occurredAt);
  return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end);
}

function confidenceFor(availableRiders: number | null, activeOrders: number): EstimateConfidence {
  if (availableRiders === null) return "medium";
  if (availableRiders <= 0) return "low";
  if (activeOrders > KITCHEN_FREE_CONCURRENCY * 3) return "low";
  if (availableRiders <= SCARCE_RIDER_THRESHOLD) return "medium";
  return "high";
}

/** Quoted windows read as "25-30 min", so both ends land on a 5-minute mark. */
function roundDownToFive(value: number): number {
  return Math.floor(value / 5) * 5;
}
function roundUpToFive(value: number): number {
  return Math.ceil(value / 5) * 5;
}

export function estimateDelivery(input: DeliveryEstimateInput): DeliveryEstimate {
  const prep = prepWindow(input.kitchenEtaMinMinutes, input.kitchenEtaMaxMinutes);
  const distanceKm = Math.max(0, finiteNumber(input.distanceKm, 0));
  const activeOrders = Math.max(0, Math.round(finiteNumber(input.activeOrders, 0)));
  const availableRiders = input.availableRiders === null
    ? null
    : Math.max(0, Math.round(finiteNumber(input.availableRiders, 0)));

  const travel = travelMinutes(distanceKm);
  const load = kitchenLoadMinutes(activeOrders);
  const wait = riderWaitMinutes(availableRiders);
  const peak = isPeakHour(input.occurredAt) ? PEAK_MINUTES : 0;
  const overheads = travel + load + wait + peak;

  const confidence = confidenceFor(availableRiders, activeOrders);
  // A less certain quote earns a wider window rather than a falsely precise
  // one: the honest answer to "we do not know if a rider is free" is a range,
  // not a sharp number that will be wrong.
  const uncertaintyPadding = confidence === "low" ? 6 : confidence === "medium" ? 3 : 0;

  let minMinutes = roundDownToFive(prep.min + overheads);
  let maxMinutes = roundUpToFive(prep.max + overheads + uncertaintyPadding);

  minMinutes = bounded(minMinutes, MIN_ETA_MINUTES, MAX_ETA_MINUTES);
  maxMinutes = bounded(maxMinutes, MIN_ETA_MINUTES, MAX_ETA_MINUTES);

  if (maxMinutes - minMinutes < MIN_SPREAD_MINUTES) {
    maxMinutes = bounded(minMinutes + MIN_SPREAD_MINUTES, MIN_ETA_MINUTES, MAX_ETA_MINUTES);
    // Only pull the lower bound in when the upper one has hit the ceiling and
    // cannot move, so the window always keeps its minimum width.
    if (maxMinutes - minMinutes < MIN_SPREAD_MINUTES) {
      minMinutes = bounded(maxMinutes - MIN_SPREAD_MINUTES, MIN_ETA_MINUTES, MAX_ETA_MINUTES);
    }
  }
  if (maxMinutes - minMinutes > MAX_SPREAD_MINUTES) {
    maxMinutes = minMinutes + MAX_SPREAD_MINUTES;
  }

  return {
    etaMinMinutes: minMinutes,
    etaMaxMinutes: maxMinutes,
    confidence,
    basis: {
      prepMinMinutes: prep.min,
      prepMaxMinutes: prep.max,
      travelMinutes: Math.round(travel * 10) / 10,
      kitchenLoadMinutes: load,
      riderWaitMinutes: wait,
      peakMinutes: peak,
      distanceKm: Math.round(distanceKm * 100) / 100,
      activeOrders,
      availableRiders,
    },
  };
}

/**
 * Counts riders who could realistically collect right now, from the
 * `riderAvailabilityByCity/{city}` node. A rider already carrying an order,
 * or whose presence ping has gone stale, is not available.
 */
export function countAvailableRiders(
  cityNode: unknown,
  now: number,
  presenceFreshMs: number,
): number {
  if (!cityNode || typeof cityNode !== "object" || Array.isArray(cityNode)) return 0;
  return Object.values(cityNode as Record<string, unknown>).filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const rider = entry as Record<string, unknown>;
    if (rider.online !== true) return false;
    if (String(rider.activeOrderId ?? "").trim().length > 0) return false;
    const updatedAt = Number(rider.updatedAt ?? 0);
    return Number.isFinite(updatedAt) && now - updatedAt <= presenceFreshMs;
  }).length;
}
