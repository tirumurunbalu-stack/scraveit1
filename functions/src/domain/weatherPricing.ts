export interface RainFeeSchedule {
  light: number;
  moderate: number;
  heavy: number;
  severe: number;
}

export interface RainTierThresholdsMm {
  light: number;
  moderate: number;
  heavy: number;
  severe: number;
}

export interface PrecipitationReading {
  probabilityPercent: number;
  quantityMm: number;
  /** Google's weatherCondition.type enum, e.g. "RAIN", "THUNDERSTORM". */
  conditionType?: string;
}

export type RainTier = "none" | "light" | "moderate" | "heavy" | "severe";

/**
 * Google's currentConditions weatherCondition.type is a direct real-time
 * observation - the same signal the consumer Weather app's icon is built
 * from - unlike precipitation.qpf.quantity, which is accumulated over the
 * PAST hour and so reads near-zero in the first few minutes of a new rain
 * event even while it is visibly raining. Any type not listed here
 * (including future values Google adds) maps to "none": fail closed rather
 * than guess. Snow-only conditions are excluded; this is a rain fee.
 */
const CONDITION_TIER: Record<string, RainTier> = {
  TYPE_UNSPECIFIED: "none",
  CLEAR: "none",
  MOSTLY_CLEAR: "none",
  PARTLY_CLOUDY: "none",
  MOSTLY_CLOUDY: "none",
  CLOUDY: "none",
  WINDY: "none",
  LIGHT_SNOW_SHOWERS: "none",
  CHANCE_OF_SNOW_SHOWERS: "none",
  SCATTERED_SNOW_SHOWERS: "none",
  SNOW_SHOWERS: "none",
  HEAVY_SNOW_SHOWERS: "none",
  LIGHT_TO_MODERATE_SNOW: "none",
  MODERATE_TO_HEAVY_SNOW: "none",
  SNOW: "none",
  LIGHT_SNOW: "none",
  HEAVY_SNOW: "none",
  SNOWSTORM: "none",
  SNOW_PERIODICALLY_HEAVY: "none",
  HEAVY_SNOW_STORM: "none",
  BLOWING_SNOW: "none",

  LIGHT_RAIN_SHOWERS: "light",
  CHANCE_OF_SHOWERS: "light",
  SCATTERED_SHOWERS: "light",
  LIGHT_RAIN: "light",
  RAIN_AND_SNOW: "light",

  LIGHT_TO_MODERATE_RAIN: "moderate",
  RAIN_SHOWERS: "moderate",
  RAIN: "moderate",
  WIND_AND_RAIN: "moderate",

  MODERATE_TO_HEAVY_RAIN: "heavy",
  HEAVY_RAIN_SHOWERS: "heavy",
  RAIN_PERIODICALLY_HEAVY: "heavy",

  // Lightning/hail risk to a rider justifies "severe" regardless of measured
  // rain intensity, so every thunderstorm/hail variant lands here.
  HEAVY_RAIN: "severe",
  THUNDERSTORM: "severe",
  THUNDERSHOWER: "severe",
  LIGHT_THUNDERSTORM_RAIN: "severe",
  SCATTERED_THUNDERSTORMS: "severe",
  HEAVY_THUNDERSTORM: "severe",
  HAIL: "severe",
  HAIL_SHOWERS: "severe",
};

function conditionTier(type: string | undefined): RainTier {
  if (!type) return "none";
  return CONDITION_TIER[type] ?? "none";
}

function accumulationTier(quantityMm: number, thresholds: RainTierThresholdsMm): RainTier {
  if (quantityMm >= thresholds.severe) return "severe";
  if (quantityMm >= thresholds.heavy) return "heavy";
  if (quantityMm >= thresholds.moderate) return "moderate";
  if (quantityMm >= thresholds.light) return "light";
  return "none";
}

function feeForTier(tier: RainTier, fees: RainFeeSchedule): number {
  if (tier === "severe") return fees.severe;
  if (tier === "heavy") return fees.heavy;
  if (tier === "moderate") return fees.moderate;
  if (tier === "light") return fees.light;
  return 0;
}

/** Matches the client's own slug() key format so admin-entered city overrides line up. */
export function normalizeCityKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The fee follows the weather Google reports right now:
 *  - weatherCondition.type: light rain charges the light fee, moderate rain
 *    the moderate fee, heavy rain the heavy fee, a thunderstorm the severe fee.
 *    Clear, cloudy, windy or snow charges nothing.
 *  - precipitation.qpf.quantity (rain over the last hour) is used only when
 *    Google gives no condition we know, gated by the admin's minimum
 *    probability. Last night's rain never raises today's fee.
 */
export function resolveRainFee(
  reading: PrecipitationReading,
  minProbabilityPercent: number,
  thresholds: RainTierThresholdsMm,
  fees: RainFeeSchedule,
): number {
  if (reading.conditionType !== undefined && reading.conditionType in CONDITION_TIER) {
    return feeForTier(conditionTier(reading.conditionType), fees);
  }
  const byAccumulation = reading.probabilityPercent >= minProbabilityPercent
    ? accumulationTier(reading.quantityMm, thresholds)
    : "none";
  return feeForTier(byAccumulation, fees);
}
