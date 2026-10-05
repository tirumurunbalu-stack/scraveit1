import {FieldValue} from "firebase-admin/firestore";
import {logger} from "firebase-functions";
import {auth, firestoreDb} from "../admin";
import {notifyAdminMapsAlert} from "./notifications";

/**
 * Guards around the paid Google Maps services (map tiles, routes, weather):
 * our own daily caps and on/off switches (settings/maps, editable in the admin
 * app), usage meters per day (private/mapsUsage/days/{IST date}), and a
 * per-account hourly limit on routes. Google's own quotas are the outer brake;
 * these keep us well inside them and tell the admins early.
 */

export type MapsMeter = "routes" | "tiles" | "weather";
export const MAPS_METERS: readonly MapsMeter[] = ["routes", "tiles", "weather"];
export const DEFAULT_DAILY_LIMITS: Readonly<Record<MapsMeter, number>> = Object.freeze({routes: 2_000, tiles: 40_000, weather: 4_000});
export const ROUTES_PER_ACCOUNT_PER_HOUR = 20;

export interface MapsSettings {
  routesEnabled: boolean;
  tilesEnabled: boolean;
  weatherEnabled: boolean;
  dailyLimits: Record<MapsMeter, number>;
}

export function normalizeMapsSettings(value: unknown): MapsSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const limits = raw.dailyLimits && typeof raw.dailyLimits === "object" ? raw.dailyLimits as Record<string, unknown> : {};
  const limit = (meter: MapsMeter) => {
    const n = Number(limits[meter]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_LIMITS[meter];
  };
  return {
    routesEnabled: raw.routesEnabled !== false,
    tilesEnabled: raw.tilesEnabled !== false,
    weatherEnabled: raw.weatherEnabled !== false,
    dailyLimits: {routes: limit("routes"), tiles: limit("tiles"), weather: limit("weather")},
  };
}

/** The day in India time, so a "day" matches what the admins see. */
export function mapsDayKey(now = Date.now()): string {
  return new Date(now + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function mapsUsageDayRef(day: string) {
  return firestoreDb.collection("private").doc("mapsUsage").collection("days").doc(day);
}

let settingsCache: {at: number; value: MapsSettings} | null = null;
export async function loadMapsSettings(now = Date.now()): Promise<MapsSettings> {
  if (settingsCache && now - settingsCache.at < 60_000) return settingsCache.value;
  const snapshot = await firestoreDb.collection("settings").doc("maps").get();
  const value = normalizeMapsSettings(snapshot.exists ? snapshot.data() : {});
  settingsCache = {at: now, value};
  return value;
}

// Counted in memory per server instance and written in small batches, so a
// busy map does not turn every tile into a database write.
const pending: Record<MapsMeter, number> = {routes: 0, tiles: 0, weather: 0};
let lastFlushAt = 0;
let usageCache: {at: number; day: string; counts: Record<MapsMeter, number>} | null = null;

export async function flushMapsUsage(now = Date.now()): Promise<void> {
  const changes = MAPS_METERS.filter((meter) => pending[meter] > 0);
  if (!changes.length) return;
  const update: Record<string, unknown> = {updatedAt: now};
  for (const meter of changes) {
    update[meter] = FieldValue.increment(pending[meter]);
    if (usageCache && usageCache.day === mapsDayKey(now)) usageCache.counts[meter] += pending[meter];
    pending[meter] = 0;
  }
  lastFlushAt = now;
  try {
    await mapsUsageDayRef(mapsDayKey(now)).set(update, {merge: true});
  } catch (error) {
    logger.warn("MAPS_USAGE_FLUSH_FAILED", {error: String(error)});
  }
}

/** Count one paid request. Routes and weather are written at once; tiles in batches. */
export async function recordMapsUsage(meter: MapsMeter, count = 1, now = Date.now()): Promise<void> {
  pending[meter] += count;
  if (meter !== "tiles" || pending.tiles >= 50 || now - lastFlushAt > 30_000) await flushMapsUsage(now);
}

async function usageToday(now = Date.now()): Promise<Record<MapsMeter, number>> {
  const day = mapsDayKey(now);
  if (usageCache && usageCache.day === day && now - usageCache.at < 30_000) return usageCache.counts;
  const snapshot = await mapsUsageDayRef(day).get();
  const data = (snapshot.exists ? snapshot.data() : {}) as Record<string, unknown>;
  const counts = {routes: Number(data.routes) || 0, tiles: Number(data.tiles) || 0, weather: Number(data.weather) || 0};
  usageCache = {at: now, day, counts};
  return counts;
}

/** Switched on, and today's use (plus what is about to be used) still under our cap. */
export async function mapsAllowed(meter: MapsMeter, needed = 1, now = Date.now()): Promise<boolean> {
  const settings = await loadMapsSettings(now);
  const enabled = meter === "routes" ? settings.routesEnabled : meter === "tiles" ? settings.tilesEnabled : settings.weatherEnabled;
  if (!enabled) return false;
  const used = (await usageToday(now))[meter] + pending[meter];
  return used + needed <= settings.dailyLimits[meter];
}

/** At most ROUTES_PER_ACCOUNT_PER_HOUR route requests per account per hour. */
export async function takeRouteAllowance(uid: string, now = Date.now()): Promise<boolean> {
  const hour = Math.floor(now / 3_600_000);
  const ref = firestoreDb.collection("private").doc("mapsUsage").collection("accounts").doc(`${uid}_${hour}`);
  return firestoreDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const count = snapshot.exists ? Number((snapshot.data() as Record<string, unknown>).count) || 0 : 0;
    if (count >= ROUTES_PER_ACCOUNT_PER_HOUR) return false;
    transaction.set(ref, {uid, hour, count: count + 1, expiresAt: (hour + 25) * 3_600_000});
    return true;
  });
}

// ---------------------------------------------------------------------------
// Route geometry helpers (server side, to tell "still on the line" apart).
// ---------------------------------------------------------------------------

export interface LatLng {lat: number; lng: number}

export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0; let lat = 0; let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0; let shift = 0; let byte = 0;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    points.push({lat: lat / 1e5, lng: lng / 1e5});
  }
  return points;
}

/** Shortest distance in metres from a point to a polyline (flat-earth, fine at city scale). */
export function distanceToRouteMeters(point: LatLng, route: LatLng[]): number {
  if (!route.length) return Infinity;
  const k = 111_320; const cos = Math.cos(point.lat * Math.PI / 180);
  const xy = (p: LatLng) => ({x: (p.lng - point.lng) * k * cos, y: (p.lat - point.lat) * k});
  let best = Infinity;
  for (let i = 0; i < route.length; i++) {
    const a = xy(route[i]!);
    if (i === route.length - 1) { best = Math.min(best, Math.hypot(a.x, a.y)); break; }
    const b = xy(route[i + 1]!);
    const dx = b.x - a.x; const dy = b.y - a.y; const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

// ---------------------------------------------------------------------------
// The watch: every 30 minutes, warn the admins at 80% and 100% of a daily cap
// (once per level per day), and once a day make sure the map cache still works.
// ---------------------------------------------------------------------------

const METER_NAMES: Record<MapsMeter, string> = {routes: "Google routes", tiles: "Google map tiles", weather: "Google weather checks"};
export const MAP_CACHE_PROBE_URL = "https://savrivo-app.web.app/maptile/day/14/11832/7527";

/** Every owner and ops admin account (for admin push alerts). */
export async function adminUids(): Promise<string[]> {
  const uids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await auth.listUsers(1000, pageToken);
    for (const user of result.users) {
      const role = String((user.customClaims ?? {}).savrivoRole ?? "");
      if (role === "owner" || role === "ops_admin") uids.push(user.uid);
    }
    if (!result.pageToken) break;
    pageToken = result.pageToken;
  }
  return uids;
}

async function raiseMapsAlert(key: string, title: string, body: string, now: number): Promise<boolean> {
  const ref = firestoreDb.collection("private").doc("mapsUsage").collection("alerts").doc(key);
  const created = await firestoreDb.runTransaction(async (transaction) => {
    if ((await transaction.get(ref)).exists) return false;
    transaction.set(ref, {key, title, body, day: mapsDayKey(now), createdAt: now});
    return true;
  });
  if (!created) return false;
  logger.warn("MAPS_USAGE_ALERT", {key, title});
  for (const uid of await adminUids()) {
    await notifyAdminMapsAlert({uid, deduplicationKey: key, title, body})
      .catch((error) => logger.warn("MAPS_ALERT_PUSH_FAILED", {uid, error: String(error)}));
  }
  return true;
}

export async function watchMapsUsage(now = Date.now()): Promise<{alerts: number; cacheChecked: boolean}> {
  await flushMapsUsage(now);
  const settings = await loadMapsSettings(now);
  const day = mapsDayKey(now);
  const snapshot = await mapsUsageDayRef(day).get();
  const data = (snapshot.exists ? snapshot.data() : {}) as Record<string, unknown>;
  let alerts = 0;
  for (const meter of MAPS_METERS) {
    const used = Number(data[meter]) || 0; const limit = settings.dailyLimits[meter];
    if (!limit) continue;
    const share = used / limit;
    if (share >= 1) {
      if (await raiseMapsAlert(`${day}_${meter}_100`, `${METER_NAMES[meter]} stopped for today`,
        `Used ${used.toLocaleString("en-IN")} of the daily limit of ${limit.toLocaleString("en-IN")}. The apps are on the free fallback until midnight. Raise the limit in Admin › Google usage if this is real demand.`, now)) alerts++;
    } else if (share >= 0.8) {
      if (await raiseMapsAlert(`${day}_${meter}_80`, `${METER_NAMES[meter]} at ${Math.round(share * 100)}% of today's limit`,
        `Used ${used.toLocaleString("en-IN")} of ${limit.toLocaleString("en-IN")}. Check Admin › Google usage.`, now)) alerts++;
    }
  }
  // Once a day: a map tile asked for twice must come back cacheable, or every view is being paid for.
  let cacheChecked = false;
  if (data.cacheCheckedOn !== day) {
    cacheChecked = true;
    try {
      const first = await fetch(MAP_CACHE_PROBE_URL);
      const second = await fetch(MAP_CACHE_PROBE_URL);
      const cacheControl = String(second.headers.get("cache-control") ?? "");
      const ok = first.ok && second.ok && /public/.test(cacheControl) && /s-maxage=\d+/.test(cacheControl);
      await mapsUsageDayRef(day).set({cacheCheckedOn: day, cacheOk: ok, cacheControl: cacheControl.slice(0, 120)}, {merge: true});
      if (!ok && first.status !== 503 && second.status !== 503) {
        if (await raiseMapsAlert(`${day}_cache`, "Map cache may be off",
          `A map tile came back with "${cacheControl || "no cache header"}" (status ${second.status}). Without the cache every map view is paid for.`, now)) alerts++;
      }
    } catch (error) {
      logger.warn("MAP_CACHE_PROBE_FAILED", {error: String(error)});
    }
  }
  return {alerts, cacheChecked};
}
