import {describe, expect, it} from "vitest";
import {
  MAX_SEARCH_TOKENS,
  catalogSearchTokens,
  restaurantIdFromTokenKey,
  searchTokenEntries,
  searchTokenRange,
  searchTokenUpdates,
} from "../src/domain/catalogSearchTokens";

const SPOT = {id: "spot1", name: "The Waffle Spot", city: "Naidupeta", cuisines: ["Desserts", "Ice Cream"]};

/** Applies a multi-path update to a plain object index, the way the database
 *  would, so a sequence of edits can be checked for leftovers. */
const apply = (index: Record<string, true>, updates: Record<string, true | null>) => {
  const next = {...index};
  Object.entries(updates).forEach(([path, value]) => {
    if (value === null) delete next[path];
    else next[path] = value;
  });
  return next;
};

describe("which words a restaurant is findable by", () => {
  it("indexes every word of the name, not just the first", () => {
    // The whole reason this index exists: citySort only matches "the".
    expect(catalogSearchTokens(SPOT)).toContain("waffle");
    expect(catalogSearchTokens(SPOT)).toContain("spot");
  });

  it("indexes cuisines, because customers search by food as often as by name", () => {
    expect(catalogSearchTokens(SPOT)).toEqual(expect.arrayContaining(["desserts", "ice", "cream"]));
  });

  it("drops words that would match most of the city", () => {
    expect(catalogSearchTokens(SPOT)).not.toContain("the");
    expect(catalogSearchTokens({id: "x", name: "Fish and Chips of the Sea", city: "Nellore"}))
      .toEqual(["chips", "fish", "sea"]);
  });

  it("keeps numbers, which are real restaurant names", () => {
    expect(catalogSearchTokens({id: "x", name: "Cafe 99", city: "Nellore"})).toEqual(["99", "cafe"]);
  });

  it("drops single characters, which are not worth a lookup", () => {
    expect(catalogSearchTokens({id: "x", name: "A1 B Grill & Co", city: "Nellore"}))
      .toEqual(["a1", "co", "grill"]);
  });

  it("is stable: the same restaurant always yields the same set", () => {
    const once = catalogSearchTokens(SPOT);
    const again = catalogSearchTokens({...SPOT, cuisines: ["Ice Cream", "Desserts"]});
    expect(again).toEqual(once);
  });

  it("does not let one record write an unbounded number of entries", () => {
    const name = Array.from({length: 200}, (_, i) => `word${i}`).join(" ");
    expect(catalogSearchTokens({id: "x", name, city: "Nellore"}).length).toBe(MAX_SEARCH_TOKENS);
  });

  it("survives junk without throwing", () => {
    expect(catalogSearchTokens({id: "x", name: null, city: null})).toEqual([]);
    expect(catalogSearchTokens({id: "x", name: "!!! ??? ***", city: "Nellore"})).toEqual([]);
    expect(catalogSearchTokens({id: "x", name: "Grill", cuisines: "not-an-array" as unknown as string[]}))
      .toEqual(["grill"]);
  });
});

describe("what gets indexed at all", () => {
  it("files a restaurant under its own city", () => {
    expect(searchTokenEntries(SPOT).cityKey).toBe("naidupeta");
    expect(searchTokenEntries({...SPOT, city: " NAIDUPETA "}).cityKey).toBe("naidupeta");
  });

  it("indexes nothing for an archived restaurant", () => {
    expect(searchTokenEntries({...SPOT, archived: true}).keys).toEqual([]);
  });

  it("indexes nothing without an id, since the key could not be unique", () => {
    expect(searchTokenEntries({...SPOT, id: ""}).keys).toEqual([]);
    expect(searchTokenEntries(null).keys).toEqual([]);
  });

  it("keeps two restaurants sharing a word apart", () => {
    const a = searchTokenEntries({id: "a", name: "Waffle House", city: "Nellore"}).keys;
    const b = searchTokenEntries({id: "b", name: "Waffle House", city: "Nellore"}).keys;
    expect(a).not.toEqual(b);
    expect(a.every((key) => !b.includes(key))).toBe(true);
  });
});

describe("keeping the index in step with the catalogue", () => {
  it("writes nothing when nothing relevant changed", () => {
    // The trigger fires on its own citySort write; an unconditional update
    // here would re-trigger it forever.
    expect(searchTokenUpdates(SPOT, {...SPOT, citySort: "x"} as typeof SPOT)).toEqual({});
    expect(searchTokenUpdates(SPOT, {...SPOT, rating: 4.6} as typeof SPOT)).toEqual({});
  });

  it("adds every entry for a brand new restaurant", () => {
    const updates = searchTokenUpdates(null, {id: "n1", name: "Zaika Grill", city: "Nellore"});
    expect(updates).toEqual({"nellore/grill|n1": true, "nellore/zaika|n1": true});
  });

  it("drops the old words on a rename, leaving nothing stale behind", () => {
    const before = {id: "n1", name: "Zaika Grill", city: "Nellore"};
    const after = {...before, name: "Zaika Biryani"};
    const index = apply({}, searchTokenUpdates(null, before));
    const renamed = apply(index, searchTokenUpdates(before, after));
    expect(Object.keys(renamed).sort()).toEqual(["nellore/biryani|n1", "nellore/zaika|n1"]);
  });

  it("moves the whole index when a restaurant changes city", () => {
    const before = {id: "n1", name: "Zaika Grill", city: "Nellore"};
    const after = {...before, city: "Tirupati"};
    const moved = apply(apply({}, searchTokenUpdates(null, before)), searchTokenUpdates(before, after));
    // Still findable in Nellore would mean showing a customer a restaurant
    // that no longer delivers anywhere near them.
    expect(Object.keys(moved).every((key) => key.startsWith("tirupati/"))).toBe(true);
    expect(Object.keys(moved).sort()).toEqual(["tirupati/grill|n1", "tirupati/zaika|n1"]);
  });

  it("removes a restaurant that is archived or deleted", () => {
    const before = {id: "n1", name: "Zaika Grill", city: "Nellore"};
    const index = apply({}, searchTokenUpdates(null, before));
    expect(apply(index, searchTokenUpdates(before, {...before, archived: true}))).toEqual({});
    expect(apply(index, searchTokenUpdates(before, null))).toEqual({});
  });

  it("brings an unarchived restaurant back", () => {
    const archived = {id: "n1", name: "Zaika Grill", city: "Nellore", archived: true};
    const live = {...archived, archived: false};
    expect(apply({}, searchTokenUpdates(archived, live)))
      .toEqual({"nellore/grill|n1": true, "nellore/zaika|n1": true});
  });

  it("only touches what actually changed", () => {
    const before = {id: "n1", name: "Zaika Grill", city: "Nellore"};
    const after = {...before, name: "Zaika Grill House"};
    // "zaika" and "grill" are already correct and must not be rewritten.
    expect(searchTokenUpdates(before, after)).toEqual({"nellore/house|n1": true});
  });
});

describe("looking a word up", () => {
  it("turns a query into a prefix range within the city", () => {
    expect(searchTokenRange("Nellore", "waff")).toEqual({cityKey: "nellore", startAt: "waff", endAt: "waff"});
  });

  it("uses the first word of a multi-word query", () => {
    expect(searchTokenRange("Nellore", "waffle spot")?.startAt).toBe("waffle");
  });

  it("has nothing to look up for an empty or punctuation-only query", () => {
    expect(searchTokenRange("Nellore", "")).toBeNull();
    expect(searchTokenRange("Nellore", "   ")).toBeNull();
    expect(searchTokenRange("Nellore", "!!!")).toBeNull();
  });

  it("reads the restaurant back out of an index key", () => {
    expect(restaurantIdFromTokenKey("waffle|spot1")).toBe("spot1");
    expect(restaurantIdFromTokenKey("waffle|id|with|pipes")).toBe("id|with|pipes");
    expect(restaurantIdFromTokenKey("malformed")).toBe("");
    expect(restaurantIdFromTokenKey(null)).toBe("");
  });

  it("finds a restaurant by a word in the middle of its name", () => {
    // End to end, against the index the trigger would have written.
    const index = apply({}, searchTokenUpdates(null, SPOT));
    const range = searchTokenRange("Naidupeta", "waffle")!;
    const hits = Object.keys(index)
      .filter((path) => path.startsWith(`${range.cityKey}/`))
      .map((path) => path.slice(range.cityKey.length + 1))
      .filter((key) => key >= range.startAt && key <= range.endAt)
      .map(restaurantIdFromTokenKey);
    expect(hits).toEqual(["spot1"]);
  });
});
