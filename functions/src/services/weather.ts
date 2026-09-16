import {logger} from "firebase-functions";
import {defineSecret} from "firebase-functions/params";
import {db} from "../admin";
import {ROOT} from "../config";
import {
  normalizeCityKey,
  resolveRainFee,
  type PrecipitationReading,
  type RainFeeSchedule,
  type RainTierThresholdsMm,
} from "../domain/weatherPricing";
import type {CatalogRestaurant} from "../types";

export const GOOGLE_WEATHER_API_KEY = defineSecret("GOOGLE_WEATHER_API_KEY");

const WEATHER_ENDPOINT = "https://weather.googleapis.com/v1/currentConditions:lookup";
// Longer than the 15-minute scan interval so one slow or skipped run doesn't
// make checkout silently fall back to "no rain fee" for legitimate rain.
const SIGNAL_VALIDITY_MS = 20 * 60 * 1000;

interface RainSettings {
  rainFeeEnabled?: boolean;
  rainMinProbability?: number;
  rainLightFee?: number;
  rainModerateFee?: number;
  rainHeavyFee?: number;
  rainSevereFee?: number;
  rainLightMm?: number;
  rainModerateMm?: number;
  rainHeavyMm?: number;
  rainSevereMm?: number;
  rainCityOverrides?: Record<string, Partial<RainFeeSchedule>>;
}

function feeSchedule(settings: RainSettings, cityKey: string): RainFeeSchedule {
  const override = cityKey ? settings.rainCityOverrides?.[cityKey] : undefined;
  return {
    light: Number(override?.light ?? settings.rainLightFee ?? 9),
    moderate: Number(override?.moderate ?? settings.rainModerateFee ?? 19),
    heavy: Number(override?.heavy ?? settings.rainHeavyFee ?? 29),
    severe: Number(override?.severe ?? settings.rainSevereFee ?? 39),
  };
}

function tierThresholds(settings: RainSettings): RainTierThresholdsMm {
  return {
    light: Number(settings.rainLightMm ?? 0.1),
    moderate: Number(settings.rainModerateMm ?? 1),
    heavy: Number(settings.rainHeavyMm ?? 4),
    severe: Number(settings.rainSevereMm ?? 10),
  };
}

/**
 * Fetches current precipitation from Google's Weather API for one point.
 * Returns null on any network/parsing failure so callers fail closed (no
 * rain fee) instead of guessing, matching loadServerFees' own idiom of only
 * ever trusting an explicit "verified_weather" signal.
 */
export async function fetchPrecipitation(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<PrecipitationReading | null> {
  try {
    const url = `${WEATHER_ENDPOINT}?key=${encodeURIComponent(apiKey)}` +
      `&location.latitude=${lat}&location.longitude=${lng}`;
    const response = await fetch(url, {method: "GET"});
    if (!response.ok) {
      logger.warn("WEATHER_API_REQUEST_FAILED", {status: response.status, lat, lng});
      return null;
    }
    const body = await response.json() as {
      precipitation?: {probability?: {percent?: number}; qpf?: {quantity?: number}};
      weatherCondition?: {type?: string};
    };
    const probabilityPercent = Number(body.precipitation?.probability?.percent);
    const quantityMm = Number(body.precipitation?.qpf?.quantity);
    if (!Number.isFinite(probabilityPercent) || !Number.isFinite(quantityMm)) {
      logger.warn("WEATHER_API_UNEXPECTED_RESPONSE", {lat, lng, body});
      return null;
    }
    return {probabilityPercent, quantityMm, conditionType: body.weatherCondition?.type};
  } catch (error) {
    logger.warn("WEATHER_API_REQUEST_ERROR", {lat, lng, error});
    return null;
  }
}

/**
 * Checks every open, non-archived restaurant against live weather and writes
 * a pricingSignals/{restaurantId} entry that loadServerFees() can trust. A
 * restaurant is left untouched (not zeroed) on a lookup failure so a prior
 * still-valid signal keeps working until its own validUntil lapses - after
 * that, loadServerFees already treats a stale/missing signal as no fee.
 */
export async function refreshRainPricingSignals(apiKey: string, now = Date.now()): Promise<{
  checked: number;
  written: number;
}> {
  const [settingsSnapshot, restaurantsSnapshot] = await Promise.all([
    db.ref(`${ROOT}/settings/customer`).get(),
    db.ref(`${ROOT}/catalog/restaurants`).get(),
  ]);
  const settings = (settingsSnapshot.val() ?? {}) as RainSettings;
  if (settings.rainFeeEnabled !== true) return {checked: 0, written: 0};

  const restaurants = Object.values((restaurantsSnapshot.val() ?? {}) as Record<string, CatalogRestaurant>)
    .filter((restaurant) => restaurant && restaurant.open === true && restaurant.archived !== true &&
      Number.isFinite(Number(restaurant.lat)) && Number.isFinite(Number(restaurant.lng)));

  const minProbability = Number(settings.rainMinProbability ?? 35);
  const thresholds = tierThresholds(settings);
  const validUntil = now + SIGNAL_VALIDITY_MS;
  const updates: Record<string, unknown> = {};

  await Promise.all(restaurants.map(async (restaurant) => {
    const reading = await fetchPrecipitation(Number(restaurant.lat), Number(restaurant.lng), apiKey);
    if (!reading) return;
    const cityKey = normalizeCityKey(restaurant.city);
    const fees = feeSchedule(settings, cityKey);
    const rainFee = resolveRainFee(reading, minProbability, thresholds, fees);
    updates[`${ROOT}/pricingSignals/${restaurant.id}`] = {
      kind: "verified_weather",
      rainFee,
      validUntil,
      checkedAt: now,
      probabilityPercent: reading.probabilityPercent,
      quantityMm: reading.quantityMm,
      ...(reading.conditionType ? {conditionType: reading.conditionType} : {}),
    };
  }));

  if (Object.keys(updates).length) await db.ref().update(updates);
  return {checked: restaurants.length, written: Object.keys(updates).length};
}
