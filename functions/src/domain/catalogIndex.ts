import {availabilityCityKey} from "./dispatch";

/**
 * A sortable, unique index value that lets the catalogue be listed, paged and
 * searched per city entirely on the server.
 *
 * The customer app previously asked for `city == <city>` with a hard
 * limitToFirst(100) and then searched what came back on the device. At one or
 * two restaurants that is fast and works offline; at a hundred and one, the
 * hundred-and-first restaurant is invisible and unfindable, and downloading a
 * whole city to search it stops being an option long before that.
 *
 * Firebase's REST API - which is what the apps use - has no two-argument
 * (value, key) cursor, so paging an `equalTo(city)` query is not possible. One
 * composite key solves all three problems instead:
 *
 *   list:   startAt "<city>|"            endAt "<city>|"
 *   page:   startAt "<last value>"       endAt "<city>|"
 *   search: startAt "<city>|<prefix>"    endAt "<city>|<prefix>"
 *
 * The trailing id keeps every value unique, so a page cursor can never sit on
 * two rows at once and silently skip or repeat one.
 */

/**  is the last character Firebase orders, so it closes a prefix range. */
export const RANGE_END_SUFFIX = "";

export function catalogNameKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

export interface CatalogIndexSource {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly city?: unknown;
}

/**
 * `<city>|<name>|<id>` - city first so a range selects exactly one city, name
 * second so the default listing is alphabetical and a name prefix is directly
 * searchable, id last purely to make the value unique.
 */
export function citySortValue(restaurant: CatalogIndexSource): string {
  const city = availabilityCityKey(restaurant.city);
  const name = catalogNameKey(restaurant.name);
  const id = String(restaurant.id ?? "").trim().slice(0, 128);
  return `${city}|${name}|${id}`;
}

export interface CatalogRange {
  readonly startAt: string;
  readonly endAt: string;
}

/** Every restaurant in one city, alphabetically. */
export function cityListingRange(city: unknown): CatalogRange {
  const key = availabilityCityKey(city);
  return {startAt: `${key}|`, endAt: `${key}|${RANGE_END_SUFFIX}`};
}

/** The same listing resumed after the last value already shown. */
export function cityListingRangeAfter(city: unknown, lastCitySortValue: string): CatalogRange {
  const range = cityListingRange(city);
  const cursor = String(lastCitySortValue ?? "");
  // A cursor from another city (or junk) must not widen the range beyond the
  // city the customer is actually browsing.
  return cursor > range.startAt && cursor < range.endAt
    ? {startAt: cursor, endAt: range.endAt}
    : range;
}

/**
 * Restaurants in one city whose name begins with the query. An empty query
 * falls back to the full city listing rather than matching nothing.
 */
export function citySearchRange(city: unknown, query: unknown): CatalogRange {
  const key = availabilityCityKey(city);
  const prefix = catalogNameKey(query);
  if (!prefix) return cityListingRange(city);
  return {startAt: `${key}|${prefix}`, endAt: `${key}|${prefix}${RANGE_END_SUFFIX}`};
}

/**
 * True when a stored value no longer matches what the restaurant should have.
 * The maintenance trigger writes only when this says so, which is what stops
 * it re-triggering itself forever.
 */
export function citySortNeedsUpdate(restaurant: CatalogIndexSource, storedValue: unknown): boolean {
  return String(storedValue ?? "") !== citySortValue(restaurant);
}
