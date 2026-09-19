import {availabilityCityKey} from "./dispatch";

/**
 * A proximity index, so a city loads nearest-first instead of alphabetically.
 *
 * citySort orders a city by name. That is the right key for search - a name
 * prefix is directly readable from it - but it is the wrong key for loading.
 * The app filters and sorts by distance, so in a city larger than the delivery
 * radius the two disagree badly: it would load the alphabetically-first page,
 * discard most of it as too far away, and never load the restaurant two
 * kilometres from the customer whose name happens to start with Z.
 *
 * geoSort is `<cityKey>|<geohash>|<id>`. A geohash shares a prefix with its
 * neighbours, so one range query over a prefix returns everything inside one
 * square cell, and the cell around the customer plus its eight neighbours
 * covers the area they can actually order from.
 *
 * The city stays in geoSort's key so a listing scoped to one city never
 * crosses into another - a restaurant can be close and still belong to a
 * city the customer is not ordering in.
 *
 * That city key is a free-text string, though, and two independent sources
 * write it: a restaurant owner types theirs once at onboarding, a customer's
 * address gets theirs from GPS reverse-geocoding. Real places have more than
 * one accepted spelling - Naidupet/Naidupeta, Bengaluru/Bangalore,
 * Visakhapatnam/Vizag - so the same real place can produce two different
 * strings, and a customer standing next to a restaurant sees nothing because
 * the two labels do not match character-for-character.
 *
 * geoSortGlobal exists for exactly this: `<geohash>|<id>`, no city at all. A
 * customer's own delivery radius is what actually decides deliverability
 * (enforced client-side, unconditionally, on every candidate this or geoSort
 * ever returns) - two real cities are essentially always farther apart than
 * any sane delivery radius, so this does not reopen the cross-city leak
 * geoSort's city key guards against; it only stops a spelling mismatch from
 * hiding a restaurant that is genuinely next door. The client tries the
 * city-scoped geoSort first and only reaches for this when that comes back
 * thin - the common case never pays for the wider, unscoped read.
 */

/** Geohash alphabet: base32 without a, i, l or o. */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** ~4.8m square. Far finer than anything asked of it, and cheap - it only
 *  makes the stored string longer, never the query wider. */
export const GEO_PRECISION = 9;

/**
 * Two query precisions, because one fixed cell size cannot serve both a dense
 * city and the platform's delivery radius at once:
 *
 * - A level-5 cell is roughly 4.7km square. Its neighbourhood only guarantees
 *   about 4.7km of coverage in every direction - well short of the platform's
 *   15km default delivery radius (`maxDeliveryKm`) - but in a dense city it
 *   stays properly selective: a handful of nearby restaurants, not the city.
 * - A level-4 cell is roughly 19.5km by 38km. Its neighbourhood comfortably
 *   exceeds the 15km default in every direction, but in a city no larger than
 *   that itself, "the neighbourhood" is indistinguishable from "the city" -
 *   exactly the unbounded read this index exists to avoid.
 *
 * So the app queries tight first and only widens to level 4 when the tight
 * query does not return enough candidates - which is the uncommon case: most
 * customers have restaurants well within 4.7km, and the wide, expensive query
 * is skipped for them entirely.
 */
export const GEO_QUERY_PRECISION_TIGHT = 5;
export const GEO_QUERY_PRECISION_WIDE = 4;

/**
 * A coordinate, or NaN.
 *
 * Deliberately not `Number(value)`: Number(null) and Number("") are both 0,
 * which would silently place every restaurant missing its coordinates at
 * 0°N 0°E - in the Atlantic, in whichever city it claims to be in.
 */
function coordinate(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

export function geohashEncode(latitude: unknown, longitude: unknown, precision = GEO_PRECISION): string {
  const lat = coordinate(latitude);
  const lng = coordinate(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return "";
  const size = Math.max(1, Math.min(12, Math.floor(precision) || GEO_PRECISION));

  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = "";
  let bits = 0;
  let bitCount = 0;
  let longitudeTurn = true;

  while (hash.length < size) {
    if (longitudeTurn) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        bits = (bits << 1) + 1;
        lngMin = mid;
      } else {
        bits <<= 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bits = (bits << 1) + 1;
        latMin = mid;
      } else {
        bits <<= 1;
        latMax = mid;
      }
    }
    longitudeTurn = !longitudeTurn;
    if (++bitCount === 5) {
      hash += BASE32[bits];
      bits = 0;
      bitCount = 0;
    }
  }
  return hash;
}

export interface GeoBounds {
  readonly latMin: number;
  readonly latMax: number;
  readonly lngMin: number;
  readonly lngMax: number;
}

/** The square a geohash covers. */
export function geohashBounds(hash: unknown): GeoBounds | null {
  const value = String(hash ?? "");
  if (!value) return null;
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let longitudeTurn = true;

  for (const character of value) {
    const index = BASE32.indexOf(character);
    if (index < 0) return null;
    for (let shift = 4; shift >= 0; shift--) {
      const bit = (index >> shift) & 1;
      if (longitudeTurn) {
        const mid = (lngMin + lngMax) / 2;
        if (bit) lngMin = mid; else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid; else latMax = mid;
      }
      longitudeTurn = !longitudeTurn;
    }
  }
  return {latMin, latMax, lngMin, lngMax};
}

/**
 * The customer's cell plus its eight neighbours.
 *
 * Derived by stepping one cell width out from the centre and re-encoding,
 * rather than from the usual neighbour lookup tables: it is the same answer
 * and there is no table to get subtly wrong. Fewer than nine cells come back
 * near a pole, where stepping past 90 degrees is not a place.
 */
export function geohashNeighborhood(
  latitude: unknown,
  longitude: unknown,
  precision = GEO_QUERY_PRECISION_TIGHT,
): string[] {
  const center = geohashEncode(latitude, longitude, precision);
  if (!center) return [];
  const bounds = geohashBounds(center);
  if (!bounds) return [];

  const latStep = bounds.latMax - bounds.latMin;
  const lngStep = bounds.lngMax - bounds.lngMin;
  const centerLat = (bounds.latMin + bounds.latMax) / 2;
  const centerLng = (bounds.lngMin + bounds.lngMax) / 2;

  const cells = new Set<string>();
  for (const latOffset of [-1, 0, 1]) {
    for (const lngOffset of [-1, 0, 1]) {
      const lat = centerLat + latOffset * latStep;
      if (lat > 90 || lat < -90) continue;
      let lng = centerLng + lngOffset * lngStep;
      // The map wraps at the date line; the cell on the other side is still
      // the neighbour.
      if (lng > 180) lng -= 360;
      if (lng < -180) lng += 360;
      const cell = geohashEncode(lat, lng, precision);
      if (cell) cells.add(cell);
    }
  }
  return [...cells].sort();
}

export interface GeoIndexSource {
  readonly id?: unknown;
  readonly city?: unknown;
  readonly lat?: unknown;
  readonly lng?: unknown;
}

/**
 * `<cityKey>|<geohash>|<id>`, or "" for a restaurant that cannot be placed on
 * the map. An unplaceable restaurant is left out of this index rather than
 * given a wrong position - it still appears in the alphabetical listing, which
 * is exactly where an address-only restaurant belongs.
 */
export function geoSortValue(restaurant: GeoIndexSource): string {
  const id = String(restaurant.id ?? "").trim().slice(0, 128);
  const hash = geohashEncode(restaurant.lat, restaurant.lng);
  if (!id || !hash) return "";
  return `${availabilityCityKey(restaurant.city)}|${hash}|${id}`;
}

/** The range covering one cell within one city. */
export function geoCellRange(city: unknown, cell: string): {startAt: string; endAt: string} {
  const key = availabilityCityKey(city);
  return {startAt: `${key}|${cell}`, endAt: `${key}|${cell}`};
}

/**
 * True when the stored value no longer matches. As with citySort, writing only
 * when this says so is what stops the maintenance trigger re-firing on its own
 * write - and "" vs a missing field must read as the same thing, or a
 * restaurant with no coordinates would be rewritten forever.
 */
export function geoSortNeedsUpdate(restaurant: GeoIndexSource, storedValue: unknown): boolean {
  return String(storedValue ?? "") !== geoSortValue(restaurant);
}

/**
 * `<geohash>|<id>` - the same position as geoSortValue, deliberately with no
 * city. See the module doc comment above for why this exists alongside it
 * rather than instead of it.
 */
export function geoSortGlobalValue(restaurant: GeoIndexSource): string {
  const id = String(restaurant.id ?? "").trim().slice(0, 128);
  const hash = geohashEncode(restaurant.lat, restaurant.lng);
  if (!id || !hash) return "";
  return `${hash}|${id}`;
}

/** The range covering one cell, with no city to scope it to. */
export function geoGlobalCellRange(cell: string): {startAt: string; endAt: string} {
  return {startAt: cell, endAt: `${cell}`};
}

/** Same purpose as geoSortNeedsUpdate, for the city-agnostic value. */
export function geoSortGlobalNeedsUpdate(restaurant: GeoIndexSource, storedValue: unknown): boolean {
  return String(storedValue ?? "") !== geoSortGlobalValue(restaurant);
}
