import {availabilityCityKey} from "./dispatch";

/**
 * A per-city word index, so search matches anywhere in a restaurant's name
 * rather than only at the start of it.
 *
 * citySort already answers "restaurants in this city whose name begins with
 * X". That is one range query and it is the right shape for browsing, but as a
 * search it is close to useless in practice: a customer looking for "The
 * Waffle Spot" types "waffle", and Indian restaurant names lead with an
 * article or honorific often enough ("The", "Sri", "Hotel", "New") that the
 * first word is rarely the word anyone searches by.
 *
 * So each meaningful word of the name - plus the cuisines, because customers
 * search "biryani" as readily as they search a name - gets its own entry:
 *
 *   /catalog/searchTokens/<cityKey>/<token>|<restaurantId> = true
 *
 * Keys sort lexicographically, so orderByKey() with a prefix range answers a
 * type-ahead of any word, in one query, without an .indexOn. The restaurant id
 * rides in the key so two restaurants sharing a word cannot collide.
 */

/** Words that are never worth an index entry: they match almost everything,
 *  and nobody searches by them. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "a", "an", "of", "at", "in", "on", "to", "by", "or",
]);

/** Enough to cover a long name plus its cuisines, without letting one
 *  pathological record write hundreds of entries. */
export const MAX_SEARCH_TOKENS = 16;
const MAX_TOKEN_LENGTH = 40;

function tokenize(value: unknown): string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.slice(0, MAX_TOKEN_LENGTH));
}

export interface SearchTokenSource {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly city?: unknown;
  readonly cuisines?: unknown;
  readonly category?: unknown;
  readonly archived?: unknown;
}

/**
 * The words a restaurant should be findable by, sorted and deduplicated so the
 * same restaurant always produces the same set - which is what lets the
 * maintenance trigger compare old against new and write nothing when they
 * agree.
 *
 * A single-character token is dropped: it matches a large share of the city
 * and costs a write to say nothing. Digits are kept, because "99" and "1947"
 * are real restaurant names.
 */
export function catalogSearchTokens(restaurant: SearchTokenSource): string[] {
  const cuisines = Array.isArray(restaurant.cuisines) ? restaurant.cuisines : [];
  const words = [
    ...tokenize(restaurant.name),
    ...cuisines.flatMap((cuisine) => tokenize(cuisine)),
    ...tokenize(restaurant.category),
  ];
  const kept = words.filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  return [...new Set(kept)].sort().slice(0, MAX_SEARCH_TOKENS);
}

/** `<token>|<restaurantId>` - unique per restaurant per word. */
export function searchTokenKey(token: string, restaurantId: unknown): string {
  return `${token}|${String(restaurantId ?? "").trim().slice(0, 128)}`;
}

export interface SearchTokenEntries {
  readonly cityKey: string;
  /** Keys under `/catalog/searchTokens/<cityKey>`. */
  readonly keys: readonly string[];
}

/**
 * Where a restaurant's entries belong, and what they are. An archived
 * restaurant, or one with no usable id, indexes nothing - it must not be
 * findable.
 */
export function searchTokenEntries(restaurant: SearchTokenSource | null): SearchTokenEntries {
  const id = String(restaurant?.id ?? "").trim();
  if (!restaurant || !id || restaurant.archived === true) return {cityKey: "", keys: []};
  return {
    cityKey: availabilityCityKey(restaurant.city),
    keys: catalogSearchTokens(restaurant).map((token) => searchTokenKey(token, id)),
  };
}

/**
 * The multi-path update that moves a restaurant's index from `before` to
 * `after`, relative to `/catalog/searchTokens`.
 *
 * Returns an empty object when nothing changed. That is the whole point: the
 * trigger also fires on its own citySort write, and an unconditional write
 * here would re-trigger itself forever.
 *
 * A rename drops the old words, and a move between cities drops the whole of
 * the old city's entries - otherwise the restaurant stays findable in a city
 * it no longer delivers to.
 */
export function searchTokenUpdates(
  before: SearchTokenSource | null,
  after: SearchTokenSource | null,
): Record<string, true | null> {
  const previous = searchTokenEntries(before);
  const next = searchTokenEntries(after);
  const path = (cityKey: string, key: string) => `${cityKey}/${key}`;

  const wanted = new Set(next.cityKey ? next.keys.map((key) => path(next.cityKey, key)) : []);
  const held = new Set(previous.cityKey ? previous.keys.map((key) => path(previous.cityKey, key)) : []);

  const updates: Record<string, true | null> = {};
  wanted.forEach((entry) => {
    if (!held.has(entry)) updates[entry] = true;
  });
  held.forEach((entry) => {
    if (!wanted.has(entry)) updates[entry] = null;
  });
  return updates;
}

/** The key range that answers a type-ahead for `query` within one city. */
export function searchTokenRange(city: unknown, query: unknown): {cityKey: string; startAt: string; endAt: string} | null {
  const cityKey = availabilityCityKey(city);
  // Only the first word is used: the range is a prefix over a single token, so
  // a multi-word query is answered by its first word and narrowed by the
  // caller against the records it gets back.
  const [prefix] = tokenize(query).filter((word) => word.length > 0);
  if (!prefix) return null;
  return {cityKey, startAt: prefix, endAt: `${prefix}`};
}

/** The restaurant id carried by an index key, or "" if the key is malformed. */
export function restaurantIdFromTokenKey(key: unknown): string {
  const value = String(key ?? "");
  const separator = value.indexOf("|");
  return separator < 0 ? "" : value.slice(separator + 1);
}
