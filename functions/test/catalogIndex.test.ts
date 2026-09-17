import {describe, expect, it} from "vitest";
import {
  catalogNameKey,
  citySearchRange,
  citySortNeedsUpdate,
  citySortValue,
  cityListingRange,
  cityListingRangeAfter,
} from "../src/domain/catalogIndex";

const inRange = (value: string, range: {startAt: string; endAt: string}) =>
  value >= range.startAt && value <= range.endAt;

/** A small multi-city catalogue, deliberately including names that collide,
 *  sort awkwardly, or share a prefix across cities. */
const CATALOG = [
  {id: "r1", name: "The Waffle Spot", city: "Naidupeta"},
  {id: "r2", name: "Highway Cross", city: "Nellore"},
  {id: "r3", name: "Waffle House", city: "Nellore"},
  {id: "r4", name: "Waffle House", city: "Tirupati"},
  {id: "r5", name: "waffle house", city: "Nellore"},
  {id: "r6", name: "Anand Bhavan", city: "Nellore"},
  {id: "r7", name: "Zaika", city: "nellore"},
].map((r) => ({...r, citySort: citySortValue(r)}));

describe("catalog index values", () => {
  it("groups by city, then sorts by name", () => {
    const nellore = CATALOG.filter((r) => inRange(r.citySort, cityListingRange("Nellore")))
      .sort((a, b) => a.citySort.localeCompare(b.citySort))
      .map((r) => r.name);
    expect(nellore).toEqual(["Anand Bhavan", "Highway Cross", "Waffle House", "waffle house", "Zaika"]);
  });

  it("treats city spelling and casing as the same city", () => {
    const range = cityListingRange("NELLORE");
    expect(inRange(citySortValue({id: "x", name: "A", city: "nellore"}), range)).toBe(true);
    expect(inRange(citySortValue({id: "x", name: "A", city: " Nellore "}), range)).toBe(true);
  });

  it("never lets one city's range pick up another city", () => {
    const range = cityListingRange("Nellore");
    const otherCities = CATALOG.filter((r) => !["Nellore", "nellore"].includes(r.city));
    expect(otherCities.every((r) => !inRange(r.citySort, range))).toBe(true);
  });

  it("keeps a unique value for identically named restaurants in one city", () => {
    const duplicates = CATALOG.filter((r) => catalogNameKey(r.name) === "waffle-house" && r.city === "Nellore");
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((r) => r.citySort)).size).toBe(2);
  });
});

describe("paging a city listing", () => {
  const page = (city: string, size: number, cursor?: string) => {
    const range = cursor ? cityListingRangeAfter(city, cursor) : cityListingRange(city);
    const rows = CATALOG.filter((r) => inRange(r.citySort, range))
      .sort((a, b) => a.citySort.localeCompare(b.citySort));
    // The cursor row itself comes back again, exactly as Firebase would return
    // it, and the caller drops it - so the test exercises that too.
    const body = cursor ? rows.filter((r) => r.citySort !== cursor) : rows;
    return body.slice(0, size);
  };

  it("walks the whole city exactly once, with no gaps or repeats", () => {
    const seen: {id: string; name: string}[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const rows = page("Nellore", 2, cursor);
      if (!rows.length) break;
      seen.push(...rows.map((r) => ({id: r.id, name: r.name})));
      cursor = rows[rows.length - 1].citySort;
    }
    expect(seen.map((r) => r.name))
      .toEqual(["Anand Bhavan", "Highway Cross", "Waffle House", "waffle house", "Zaika"]);
    // Two restaurants share a name; paging must still return each exactly once.
    expect(new Set(seen.map((r) => r.id)).size).toBe(seen.length);
    expect(seen).toHaveLength(CATALOG.filter((r) => r.city.toLowerCase() === "nellore").length);
  });

  it("ignores a cursor from another city rather than leaking into it", () => {
    const foreign = CATALOG.find((r) => r.city === "Tirupati")!.citySort;
    expect(cityListingRangeAfter("Nellore", foreign)).toEqual(cityListingRange("Nellore"));
  });

  it("ignores a junk cursor", () => {
    expect(cityListingRangeAfter("Nellore", "")).toEqual(cityListingRange("Nellore"));
    expect(cityListingRangeAfter("Nellore", "!!!")).toEqual(cityListingRange("Nellore"));
  });
});

describe("searching within a city", () => {
  const search = (city: string, query: string) =>
    CATALOG.filter((r) => inRange(r.citySort, citySearchRange(city, query)))
      .sort((a, b) => a.citySort.localeCompare(b.citySort))
      .map((r) => r.name);

  it("finds restaurants by name prefix, in that city only", () => {
    expect(search("Nellore", "waffle")).toEqual(["Waffle House", "waffle house"]);
    expect(search("Tirupati", "waffle")).toEqual(["Waffle House"]);
    expect(search("Naidupeta", "waffle")).toEqual([]);
  });

  it("matches the start of the name, not the middle", () => {
    expect(search("Naidupeta", "the")).toEqual(["The Waffle Spot"]);
    expect(search("Naidupeta", "spot")).toEqual([]);
  });

  it("is case and punctuation insensitive", () => {
    expect(search("Nellore", "WAFFLE")).toEqual(["Waffle House", "waffle house"]);
    expect(search("Nellore", "  waffle  ")).toEqual(["Waffle House", "waffle house"]);
  });

  it("falls back to the whole city for an empty query", () => {
    expect(citySearchRange("Nellore", "")).toEqual(cityListingRange("Nellore"));
    expect(citySearchRange("Nellore", "   ")).toEqual(cityListingRange("Nellore"));
  });
});

describe("index maintenance", () => {
  it("reports an update only when the stored value is actually wrong", () => {
    const restaurant = {id: "r1", name: "The Waffle Spot", city: "Naidupeta"};
    const current = citySortValue(restaurant);
    expect(citySortNeedsUpdate(restaurant, current)).toBe(false);
    expect(citySortNeedsUpdate(restaurant, undefined)).toBe(true);
    expect(citySortNeedsUpdate({...restaurant, name: "Renamed"}, current)).toBe(true);
    expect(citySortNeedsUpdate({...restaurant, city: "Nellore"}, current)).toBe(true);
  });

  it("produces a usable value even for junk catalogue data", () => {
    const value = citySortValue({id: "", name: "", city: ""});
    expect(typeof value).toBe("string");
    expect(value.split("|")).toHaveLength(3);
    expect(inRange(value, cityListingRange(""))).toBe(true);
  });
});
