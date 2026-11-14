import type {GeoPoint} from "../types";

/**
 * Colleges, universities, schools and hospitals often stop delivery partners
 * at the gate, far from the customer's pin, so the normal 100 m arrival check
 * can never pass. Google tells us when a pin is INSIDE such a place (address
 * descriptors: "WITHIN" or "OUTSKIRTS", never "NEAR"), and Places gives the
 * place's type and its box on the map.
 *
 * For those orders only, on top of the normal rules:
 *  - the customer is told when the partner reaches the campus;
 *  - a partner standing still at the campus for 3 minutes is treated as
 *    arrived ("waiting near the gate"): the delivery code box opens and the
 *    customer's code is still what proves the delivery.
 * A partner allowed inside keeps moving, so the normal Near you / Arrived
 * steps happen as usual.
 */

export const CAMPUS_PLACE_TYPES: ReadonlySet<string> = new Set([
  "university", "school", "primary_school", "secondary_school",
  // Many Indian colleges (e.g. NBKR Institute, Vidyanagar) carry only this type.
  "educational_institution",
  "hospital", "general_hospital", "medical_center",
]);
/** How far outside the campus box still counts as "at the campus" (gates sit on the boundary road). */
export const CAMPUS_EDGE_MARGIN_METERS = 150;
export const CAMPUS_WAIT_MS = 3 * 60_000;
/** GPS wander allowed while standing still. */
export const CAMPUS_STILL_METERS = 60;
/** A "campus" bigger than this across is not a campus (bad data); ignore it. */
const CAMPUS_MAX_SPAN_METERS = 6_000;
/** Used when Google gives a point but no box. */
const CAMPUS_POINT_HALF_SPAN_METERS = 300;
const METERS_PER_DEGREE = 111_320;

export interface CampusZone {
  placeId: string;
  name: string;
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface InsidePlace {
  placeId: string;
  name: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

/**
 * The places Google says the pin is inside, smallest first. "NEAR" areas and
 * landmarks that are only beside or across the road are left out, so a house
 * near a hospital is not a campus.
 */
export function placesContainingPin(descriptor: unknown): InsidePlace[] {
  if (!descriptor || typeof descriptor !== "object") return [];
  const raw = descriptor as {areas?: unknown; landmarks?: unknown};
  const out: InsidePlace[] = [];
  const add = (item: Record<string, unknown>) => {
    const placeId = text(item.place_id);
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId) || out.some((p) => p.placeId === placeId)) return;
    out.push({placeId, name: text((item.display_name as Record<string, unknown> | undefined)?.text)});
  };
  for (const area of Array.isArray(raw.areas) ? raw.areas : []) {
    if (area && typeof area === "object" && ["WITHIN", "OUTSKIRTS"].includes(String((area as Record<string, unknown>).containment))) {
      add(area as Record<string, unknown>);
    }
  }
  for (const landmark of Array.isArray(raw.landmarks) ? raw.landmarks : []) {
    if (landmark && typeof landmark === "object" && (landmark as Record<string, unknown>).spatial_relationship === "WITHIN") {
      add(landmark as Record<string, unknown>);
    }
  }
  return out.slice(0, 3);
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function lngMeters(lat: number): number {
  return METERS_PER_DEGREE * Math.max(0.2, Math.cos(lat * Math.PI / 180));
}

/**
 * Starting half-size by kind of place, used when Google has no real boundary
 * for it (its generic ~300 m box): a college campus is much bigger than a
 * school or a hospital. Each place then grows to its real gates as orders are
 * delivered there (see learnCampusGate).
 */
const CAMPUS_TYPE_HALF_SPAN_METERS: ReadonlyArray<[string, number]> = [
  ["university", 500], ["educational_institution", 500],
  ["hospital", 300], ["general_hospital", 300], ["medical_center", 250],
  ["school", 250], ["primary_school", 200], ["secondary_school", 250],
];
/** Google's viewport when it knows only a point: about 300 m on each side. */
const DEFAULT_VIEWPORT_MIN_METERS = 250;
const DEFAULT_VIEWPORT_MAX_METERS = 350;
/** A learned gate further than this from the campus centre is not this campus's gate. */
export const CAMPUS_GATE_MAX_FROM_CENTER_METERS = 1_500;
const CAMPUS_GATE_MAX_POINTS = 12;
const CAMPUS_GATE_SAME_SPOT_METERS = 60;

function typeHalfSpan(types: string[]): number {
  let best = 0;
  for (const [type, half] of CAMPUS_TYPE_HALF_SPAN_METERS) if (types.includes(type)) best = Math.max(best, half);
  return best || CAMPUS_POINT_HALF_SPAN_METERS;
}

/** A campus zone from Places details (types, viewport, location), or null when it is not a campus type. */
export function campusZoneFromPlace(place: InsidePlace, details: unknown): CampusZone | null {
  if (!details || typeof details !== "object") return null;
  const raw = details as {types?: unknown; viewport?: unknown; location?: unknown};
  const types = Array.isArray(raw.types) ? raw.types.map(String) : [];
  if (!types.some((type) => CAMPUS_PLACE_TYPES.has(type))) return null;
  const viewport = raw.viewport as {low?: {latitude?: unknown; longitude?: unknown}; high?: {latitude?: unknown; longitude?: unknown}} | undefined;
  let south = finite(viewport?.low?.latitude), west = finite(viewport?.low?.longitude);
  let north = finite(viewport?.high?.latitude), east = finite(viewport?.high?.longitude);
  const location = raw.location as {latitude?: unknown; longitude?: unknown} | undefined;
  const pointLat = finite(location?.latitude), pointLng = finite(location?.longitude);
  const hasViewport = south !== null && west !== null && north !== null && east !== null && south < north && west < east;
  const spanLat = hasViewport ? (north! - south!) * METERS_PER_DEGREE : 0;
  const spanLng = hasViewport ? (east! - west!) * lngMeters((south! + north!) / 2) : 0;
  // Google's generic box (no real boundary known): size it by the kind of place instead.
  const generic = !hasViewport || (spanLat >= DEFAULT_VIEWPORT_MIN_METERS && spanLat <= DEFAULT_VIEWPORT_MAX_METERS &&
    spanLng >= DEFAULT_VIEWPORT_MIN_METERS && spanLng <= DEFAULT_VIEWPORT_MAX_METERS);
  if (generic) {
    const lat = pointLat ?? (hasViewport ? (south! + north!) / 2 : null);
    const lng = pointLng ?? (hasViewport ? (west! + east!) / 2 : null);
    if (lat === null || lng === null) return null;
    const half = typeHalfSpan(types);
    const dLat = half / METERS_PER_DEGREE, dLng = half / lngMeters(lat);
    south = lat - dLat; north = lat + dLat; west = lng - dLng; east = lng + dLng;
  }
  const midLat = (south! + north!) / 2;
  if ((north! - south!) * METERS_PER_DEGREE > CAMPUS_MAX_SPAN_METERS ||
    (east! - west!) * lngMeters(midLat) > CAMPUS_MAX_SPAN_METERS) return null;
  return {placeId: place.placeId, name: place.name, south: south!, west: west!, north: north!, east: east!};
}

export interface CampusGatePoint extends GeoPoint {
  at: number;
}

function zoneCenter(zone: CampusZone): GeoPoint {
  return {lat: (zone.south + zone.north) / 2, lng: (zone.west + zone.east) / 2};
}

function metersBetween(a: GeoPoint, b: GeoPoint): number {
  const dLat = (a.lat - b.lat) * METERS_PER_DEGREE;
  const dLng = (a.lng - b.lng) * lngMeters((a.lat + b.lat) / 2);
  return Math.hypot(dLat, dLng);
}

/** The campus box grown to take in the gates where its orders were really handed over. */
export function campusZoneWithGates(zone: CampusZone, gates: readonly GeoPoint[]): CampusZone {
  const center = zoneCenter(zone);
  const out = {...zone};
  for (const gate of gates) {
    if (!Number.isFinite(gate.lat) || !Number.isFinite(gate.lng)) continue;
    if (metersBetween(center, gate) > CAMPUS_GATE_MAX_FROM_CENTER_METERS) continue;
    out.south = Math.min(out.south, gate.lat); out.north = Math.max(out.north, gate.lat);
    out.west = Math.min(out.west, gate.lng); out.east = Math.max(out.east, gate.lng);
  }
  return out;
}

/**
 * Where a campus order was handed over, if it adds a new gate to remember:
 * outside the current box (+ margin), near enough to be this campus, and not a
 * spot already known. Returns the new gate list, or null when nothing changes.
 */
export function learnCampusGate(
  zone: CampusZone, gates: readonly CampusGatePoint[], handover: GeoPoint & {accuracy: number}, now: number,
): CampusGatePoint[] | null {
  if (!(handover.accuracy >= 0 && handover.accuracy <= 80)) return null;
  if (atCampus(handover, campusZoneWithGates(zone, gates))) return null;
  if (metersBetween(zoneCenter(zone), handover) > CAMPUS_GATE_MAX_FROM_CENTER_METERS) return null;
  if (gates.some((gate) => metersBetween(gate, handover) < CAMPUS_GATE_SAME_SPOT_METERS)) return null;
  return [...gates, {lat: handover.lat, lng: handover.lng, at: now}].slice(-CAMPUS_GATE_MAX_POINTS);
}

export function normalizeCampusGates(value: unknown): CampusGatePoint[] {
  return (Array.isArray(value) ? value : [])
    .map((raw) => ({lat: finite((raw as Record<string, unknown>)?.lat), lng: finite((raw as Record<string, unknown>)?.lng), at: finite((raw as Record<string, unknown>)?.at) ?? 0}))
    .filter((g): g is CampusGatePoint => g.lat !== null && g.lng !== null)
    .slice(-CAMPUS_GATE_MAX_POINTS);
}

/** Inside the campus box, or within the edge margin around it. */
export function atCampus(point: GeoPoint, zone: CampusZone, marginMeters = CAMPUS_EDGE_MARGIN_METERS): boolean {
  const dLat = marginMeters / METERS_PER_DEGREE;
  const dLng = marginMeters / lngMeters(point.lat);
  return point.lat >= zone.south - dLat && point.lat <= zone.north + dLat &&
    point.lng >= zone.west - dLng && point.lng <= zone.east + dLng;
}

/** How old the partner's last GPS reading may be when they swipe "I'm here" at a campus. */
export const CAMPUS_SWIPE_MAX_FIX_AGE_MS = 60_000;
const CAMPUS_SWIPE_FUTURE_SKEW_MS = 5_000;
const CAMPUS_SWIPE_MAX_ACCURACY_METERS = 80;

/**
 * The customer is often already waiting at the gate, so the partner's own
 * "I'm at the delivery location" swipe opens the delivery code box at once,
 * without the 3-minute wait, when their latest GPS reading is fresh, sharp
 * enough and at this campus. The customer's code still completes the delivery.
 */
export function partnerAtCampusNow(
  fix: GeoPoint & {accuracy: number; updatedAt: number},
  zone: CampusZone,
  now: number,
): boolean {
  return fix.updatedAt >= now - CAMPUS_SWIPE_MAX_FIX_AGE_MS && fix.updatedAt <= now + CAMPUS_SWIPE_FUTURE_SKEW_MS &&
    fix.accuracy >= 0 && fix.accuracy <= CAMPUS_SWIPE_MAX_ACCURACY_METERS && atCampus(fix, zone);
}

export function normalizeCampusZone(value: unknown): CampusZone | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const south = finite(raw.south), west = finite(raw.west), north = finite(raw.north), east = finite(raw.east);
  if (south === null || west === null || north === null || east === null || south >= north || west >= east) return null;
  return {placeId: text(raw.placeId), name: text(raw.name), south, west, north, east};
}
