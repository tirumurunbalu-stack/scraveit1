/**
 * Road distance for the delivery fee (founder 18 Nov 2026: "do not calculate straight km,
 * calculate road km like Swiggy or Zomato").
 *
 * One Google two-wheeler route per store + address pair, saved in
 * private/roadDistances/pairs so checkout, the order and later orders to the same address
 * all charge the same km without asking Google again. When Google is off, slow, over the
 * daily maps budget or the key is missing, the road is estimated as straight line × 1.3
 * (not saved, so the next checkout tries Google again).
 */
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {mapsAllowed, recordMapsUsage, type LatLng} from "./mapsGuard";
import {GOOGLE_WEATHER_API_KEY} from "./weather";

const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const ROAD_FACTOR_ESTIMATE = 1.3;
const SAVED_FOR_MS = 180 * 24 * 60 * 60 * 1000;
const GOOGLE_TIMEOUT_MS = 2500;

export interface RoadDistance {
  /** Road km, rounded to 0.1 km. */
  readonly km: number;
  readonly source: "saved" | "google" | "estimate";
}

const memory = new Map<string, {km: number; at: number}>();

/** Same pair key for checkout and the order: store id + address rounded to about 1 m. */
export function roadPairKey(storeId: string, drop: LatLng): string {
  return `${storeId}_${drop.lat.toFixed(5)}_${drop.lng.toFixed(5)}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function roundKm(km: number): number {
  return Math.round(Math.max(0, km) * 10) / 10;
}

/** Road can never be shorter than the straight line; a straight × 1.3 guess when Google is unavailable. */
export function estimatedRoadKm(straightKm: number): number {
  return roundKm(straightKm * ROAD_FACTOR_ESTIMATE);
}

function apiKey(): string {
  try {
    return GOOGLE_WEATHER_API_KEY.value() || "";
  } catch {
    return "";
  }
}

async function googleRoadMeters(origin: LatLng, destination: LatLng, key: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    const response = await fetch(ROUTES_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {"Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters"},
      body: JSON.stringify({
        origin: {location: {latLng: {latitude: origin.lat, longitude: origin.lng}}},
        destination: {location: {latLng: {latitude: destination.lat, longitude: destination.lng}}},
        travelMode: "TWO_WHEELER", languageCode: "en-IN", regionCode: "IN", units: "METRIC",
      }),
    });
    if (!response.ok) {
      logger.warn("ROAD_DISTANCE_FAILED", {status: response.status, body: (await response.text()).slice(0, 300)});
      return null;
    }
    const body = await response.json() as {routes?: {distanceMeters?: number}[]};
    const meters = Number(body.routes?.[0]?.distanceMeters);
    return Number.isFinite(meters) && meters > 0 ? meters : null;
  } catch (error) {
    logger.warn("ROAD_DISTANCE_FAILED", {error: String(error)});
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function roadDistanceKm(
  store: {id: string; lat: unknown; lng: unknown},
  drop: {lat: unknown; lng: unknown},
  straightKm: number,
): Promise<RoadDistance> {
  const origin = {lat: Number(store.lat), lng: Number(store.lng)};
  const destination = {lat: Number(drop.lat), lng: Number(drop.lng)};
  const fallback: RoadDistance = {km: estimatedRoadKm(straightKm), source: "estimate"};
  if (![origin.lat, origin.lng, destination.lat, destination.lng].every(Number.isFinite)) return fallback;
  const key = roadPairKey(String(store.id), destination);
  const now = Date.now();
  // Never below the straight line (protects against a bad saved value).
  const sane = (km: number) => roundKm(Math.max(km, straightKm));

  const inMemory = memory.get(key);
  if (inMemory && now - inMemory.at < SAVED_FOR_MS) return {km: sane(inMemory.km), source: "saved"};
  const ref = firestoreDb.collection("private").doc("roadDistances").collection("pairs").doc(key);
  try {
    const snapshot = await ref.get();
    const saved = snapshot.exists ? snapshot.data() as {km?: unknown; at?: unknown} : null;
    if (saved && Number(saved.km) > 0 && now - Number(saved.at) < SAVED_FOR_MS) {
      memory.set(key, {km: Number(saved.km), at: Number(saved.at)});
      return {km: sane(Number(saved.km)), source: "saved"};
    }
  } catch (error) {
    logger.warn("ROAD_DISTANCE_READ_FAILED", {error: String(error)});
  }

  const googleKey = apiKey();
  if (!googleKey || !await mapsAllowed("routes").catch(() => false)) return fallback;
  const meters = await googleRoadMeters(origin, destination, googleKey);
  await recordMapsUsage("routes").catch(() => undefined);
  if (meters === null) return fallback;
  const km = meters / 1000;
  memory.set(key, {km, at: now});
  await ref.set({km, storeId: String(store.id), lat: destination.lat, lng: destination.lng, straightKm, at: now})
    .catch((error) => logger.warn("ROAD_DISTANCE_SAVE_FAILED", {error: String(error)}));
  return {km: sane(km), source: "google"};
}
