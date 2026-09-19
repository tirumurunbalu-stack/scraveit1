import {describe, expect, it} from "vitest";
import {
  GEO_QUERY_PRECISION_TIGHT,
  GEO_QUERY_PRECISION_WIDE,
  geoCellRange,
  geoGlobalCellRange,
  geoSortGlobalNeedsUpdate,
  geoSortGlobalValue,
  geoSortNeedsUpdate,
  geoSortValue,
  geohashBounds,
  geohashEncode,
  geohashNeighborhood,
} from "../src/domain/catalogGeoIndex";

/** The platform's default delivery radius (`maxDeliveryKm` in
 *  native_android/app/src/main/assets/premium.js). The wide query tier exists
 *  specifically to cover this; if that default ever changes, this is the
 *  number to change here too. */
const DEFAULT_DELIVERY_RADIUS_KM = 15;
import {citySortValue} from "../src/domain/catalogIndex";

const NELLORE = {lat: 14.4426, lng: 79.9865};

/** Great-circle distance, used only to check the index against the truth it is
 *  meant to approximate. */
function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

describe("geohash", () => {
  it("matches the reference encoding", () => {
    // The standard worked example from the geohash definition.
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
  });

  it("places the extremes of the world without running off the end", () => {
    expect(geohashEncode(0, 0, 4)).toBe("s000");
    expect(geohashEncode(90, 180, 4)).toBe("zzzz");
    expect(geohashEncode(-90, -180, 4)).toBe("0000");
  });

  it("gives nearby points a shared prefix and distant ones none", () => {
    const here = geohashEncode(NELLORE.lat, NELLORE.lng, 6);
    const close = geohashEncode(NELLORE.lat + 0.001, NELLORE.lng + 0.001, 6);
    const far = geohashEncode(28.6139, 77.209, 6); // Delhi
    expect(close.slice(0, 4)).toBe(here.slice(0, 4));
    // A level-1 cell spans 45 degrees, so two cities in the same country can
    // share a first character; what matters is that they diverge quickly.
    expect(far.slice(0, 3)).not.toBe(here.slice(0, 3));
  });

  it("refuses coordinates that are not coordinates", () => {
    [[null, null], [undefined, undefined], ["abc", "def"], [NaN, 0], [91, 0], [0, 181], [-91, 0]]
      .forEach(([lat, lng]) => expect(geohashEncode(lat, lng)).toBe(""));
  });

  it("decodes to a box that contains the point it encoded", () => {
    [[NELLORE.lat, NELLORE.lng], [0, 0], [-33.8688, 151.2093], [51.5074, -0.1278]].forEach(([lat, lng]) => {
      const bounds = geohashBounds(geohashEncode(lat, lng, 7))!;
      expect(lat).toBeGreaterThanOrEqual(bounds.latMin);
      expect(lat).toBeLessThanOrEqual(bounds.latMax);
      expect(lng).toBeGreaterThanOrEqual(bounds.lngMin);
      expect(lng).toBeLessThanOrEqual(bounds.lngMax);
    });
  });

  it("rejects a malformed hash rather than decoding nonsense", () => {
    expect(geohashBounds("a")).toBeNull(); // not in the geohash alphabet
    expect(geohashBounds("")).toBeNull();
    expect(geohashBounds(null)).toBeNull();
  });
});

/** Every compass direction covered from `origin` at `km` out, using the
 *  9-cell neighbourhood at `precision`. */
function neighborhoodCoversRadius(origin: {lat: number; lng: number}, precision: number, km: number): boolean {
  const covered = geohashNeighborhood(origin.lat, origin.lng, precision).map((cell) => geohashBounds(cell)!);
  const inside = (lat: number, lng: number) => covered.some((b) =>
    lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax);
  for (let bearing = 0; bearing < 360; bearing += 30) {
    const radians = (bearing * Math.PI) / 180;
    const lat = origin.lat + (km / 111) * Math.cos(radians);
    const lng = origin.lng + (km / (111 * Math.cos((origin.lat * Math.PI) / 180))) * Math.sin(radians);
    if (!inside(lat, lng)) return false;
  }
  return true;
}

describe("the cells a customer's query covers", () => {
  it("is the customer's own cell plus its eight neighbours", () => {
    const cells = geohashNeighborhood(NELLORE.lat, NELLORE.lng, GEO_QUERY_PRECISION_TIGHT);
    expect(cells).toHaveLength(9);
    expect(cells).toContain(geohashEncode(NELLORE.lat, NELLORE.lng, GEO_QUERY_PRECISION_TIGHT));
    expect(new Set(cells).size).toBe(9);
  });

  const CITIES = [
    {lat: 14.4426, lng: 79.9865},
    {lat: 14.4000, lng: 79.9000},
    {lat: 12.9716, lng: 77.5946}, // Bengaluru
    {lat: 17.3850, lng: 78.4867}, // Hyderabad
  ];

  it("covers every direction at the tight precision, wherever in their own cell the customer stands", () => {
    // This is the property the tight tier rests on: a customer at the very
    // corner of their cell must still have the area right around them
    // covered. 4km is comfortably inside the ~4.7km guarantee at precision 5.
    CITIES.forEach((origin) => {
      expect(neighborhoodCoversRadius(origin, GEO_QUERY_PRECISION_TIGHT, 4), JSON.stringify(origin)).toBe(true);
    });
  });

  it("does NOT reliably cover the platform's delivery radius at the tight precision alone", () => {
    // The reason the wide tier exists at all, stated as a test: without it,
    // a restaurant up to 15km away - fully within delivery range - can sit
    // outside the tight neighbourhood and never be offered to the customer.
    const anyCityFailsAt15km = CITIES.some(
      (origin) => !neighborhoodCoversRadius(origin, GEO_QUERY_PRECISION_TIGHT, DEFAULT_DELIVERY_RADIUS_KM));
    expect(anyCityFailsAt15km).toBe(true);
  });

  it("covers the platform's full delivery radius at the wide precision", () => {
    CITIES.forEach((origin) => {
      expect(neighborhoodCoversRadius(origin, GEO_QUERY_PRECISION_WIDE, DEFAULT_DELIVERY_RADIUS_KM),
        JSON.stringify(origin)).toBe(true);
    });
  });

  it("does not fall apart at the date line or the poles", () => {
    [GEO_QUERY_PRECISION_TIGHT, GEO_QUERY_PRECISION_WIDE].forEach((precision) => {
      expect(geohashNeighborhood(0, 179.9999, precision).length).toBe(9);
      expect(geohashNeighborhood(0, -179.9999, precision).length).toBe(9);
      // Stepping past the pole is not a place, so there are fewer neighbours.
      expect(geohashNeighborhood(89.9999, 0, precision).length).toBeLessThanOrEqual(9);
      expect(geohashNeighborhood(89.9999, 0, precision).length).toBeGreaterThan(0);
    });
  });

  it("has nothing to query for a customer with no pin", () => {
    expect(geohashNeighborhood(null, null)).toEqual([]);
    expect(geohashNeighborhood("x", "y")).toEqual([]);
  });
});

describe("the stored index value", () => {
  it("is city, then position, then id", () => {
    const value = geoSortValue({id: "r1", city: "Nellore", ...NELLORE});
    const [city, hash, id] = value.split("|");
    expect(city).toBe("nellore");
    expect(hash).toBe(geohashEncode(NELLORE.lat, NELLORE.lng));
    expect(id).toBe("r1");
  });

  it("treats the same city spelled differently as one city", () => {
    const a = geoSortValue({id: "r1", city: " NELLORE ", ...NELLORE});
    const b = geoSortValue({id: "r1", city: "nellore", ...NELLORE});
    expect(a).toBe(b);
  });

  it("leaves an unplaceable restaurant out rather than guessing where it is", () => {
    expect(geoSortValue({id: "r1", city: "Nellore"})).toBe("");
    expect(geoSortValue({id: "r1", city: "Nellore", lat: null, lng: null})).toBe("");
    expect(geoSortValue({id: "", city: "Nellore", ...NELLORE})).toBe("");
  });

  it("writes only when the stored value is actually wrong", () => {
    const restaurant = {id: "r1", city: "Nellore", ...NELLORE};
    const current = geoSortValue(restaurant);
    expect(geoSortNeedsUpdate(restaurant, current)).toBe(false);
    expect(geoSortNeedsUpdate(restaurant, undefined)).toBe(true);
    expect(geoSortNeedsUpdate({...restaurant, lat: 14.5}, current)).toBe(true);
    expect(geoSortNeedsUpdate({...restaurant, city: "Tirupati"}, current)).toBe(true);
  });

  it("does not rewrite an unplaceable restaurant forever", () => {
    // "" and a missing field have to read as the same thing, or the trigger
    // would rewrite this record on every pass.
    const restaurant = {id: "r1", city: "Nellore"};
    expect(geoSortNeedsUpdate(restaurant, undefined)).toBe(false);
    expect(geoSortNeedsUpdate(restaurant, null)).toBe(false);
    expect(geoSortNeedsUpdate(restaurant, "")).toBe(false);
  });
});

describe("what this actually fixes", () => {
  /** A city 40km across holding 500 restaurants, named so that alphabetical
   *  order and geographic order are unrelated - which is the real situation. */
  const CITY = Array.from({length: 500}, (_, i) => {
    const angle = (i * 137.5 * Math.PI) / 180;
    const radiusKm = 20 * ((i + 1) / 500);
    const lat = NELLORE.lat + (radiusKm / 111) * Math.cos(angle);
    const lng = NELLORE.lng + (radiusKm / (111 * Math.cos((NELLORE.lat * Math.PI) / 180))) * Math.sin(angle);
    // 317 is coprime with 500, so the name ordering is a clean shuffle of the
    // distance ordering. A fixture where the nearest restaurants also happen
    // to be named first would prove nothing.
    const named = (i * 317) % 500;
    const restaurant = {
      id: `r${String(i).padStart(3, "0")}`,
      name: `${String.fromCharCode(97 + (named % 26))}${named} Kitchen`,
      city: "Nellore",
      lat,
      lng,
    };
    return {
      ...restaurant,
      citySort: citySortValue(restaurant),
      geoSort: geoSortValue(restaurant),
      km: distanceKm(NELLORE.lat, NELLORE.lng, lat, lng),
    };
  });

  const inCells = (cells: string[]) => {
    const ranges = cells.map((cell) => geoCellRange("Nellore", cell));
    return CITY.filter((r) => ranges.some((range) => r.geoSort >= range.startAt && r.geoSort <= range.endAt));
  };

  it("loading alphabetically misses restaurants that are right next door", () => {
    // The bug, stated as a test: this is what the app did before geoSort.
    const alphabetical = [...CITY].sort((a, b) => a.citySort.localeCompare(b.citySort)).slice(0, 320);
    const loaded = new Set(alphabetical.map((r) => r.id));
    const nearbyMissed = CITY.filter((r) => r.km <= 3 && !loaded.has(r.id));
    expect(nearbyMissed.length).toBeGreaterThan(0);
  });

  it("loading by proximity finds them", () => {
    const found = new Set(inCells(geohashNeighborhood(NELLORE.lat, NELLORE.lng)).map((r) => r.id));
    const nearby = CITY.filter((r) => r.km <= 3);
    expect(nearby.length).toBeGreaterThan(0);
    expect(nearby.every((r) => found.has(r.id))).toBe(true);
  });

  it("returns a working page of candidates, not the whole city", () => {
    const found = inCells(geohashNeighborhood(NELLORE.lat, NELLORE.lng));
    expect(found.length).toBeGreaterThanOrEqual(40);
    expect(found.length).toBeLessThan(CITY.length);
  });

  it("never reaches into another city", () => {
    const tirupati = {id: "t1", city: "Tirupati", lat: NELLORE.lat + 0.001, lng: NELLORE.lng + 0.001};
    const value = geoSortValue(tirupati);
    // Next door, but a different city: the range must not contain it.
    const ranges = geohashNeighborhood(NELLORE.lat, NELLORE.lng).map((cell) => geoCellRange("Nellore", cell));
    expect(ranges.some((range) => value >= range.startAt && value <= range.endAt)).toBe(false);
  });

  it("widening to the wide tier finds restaurants the tight tier misses", () => {
    // The client widens only when the tight tier comes back thin. Simulated
    // here directly against the index rather than the client's fetch loop.
    const tight = inCells(geohashNeighborhood(NELLORE.lat, NELLORE.lng, GEO_QUERY_PRECISION_TIGHT));
    const wide = inCells(geohashNeighborhood(NELLORE.lat, NELLORE.lng, GEO_QUERY_PRECISION_WIDE));
    expect(wide.length).toBeGreaterThan(tight.length);
    expect(tight.every((r) => wide.some((w) => w.id === r.id))).toBe(true);
  });

  it("a customer somewhere else in the city gets a different set", () => {
    const here = new Set(inCells(geohashNeighborhood(NELLORE.lat, NELLORE.lng)).map((r) => r.id));
    const there = new Set(inCells(geohashNeighborhood(NELLORE.lat + 0.15, NELLORE.lng + 0.15)).map((r) => r.id));
    expect(there.size).toBeGreaterThan(0);
    expect([...there].some((id) => !here.has(id))).toBe(true);
  });
});

describe("the city-agnostic index (geoSortGlobal)", () => {
  // The real, reported bug: a restaurant owner typed "Naidupeta"; the same
  // customer's GPS-detected address came back "Naidupet". One real place,
  // two strings - geoSort's city-scoped range finds nothing for either party
  // because they never match character-for-character.
  const RESTAURANT = {id: "waffle1", name: "The Waffle Spot", city: "Naidupeta", lat: 13.91747864, lng: 79.89603288};
  const CUSTOMER = {lat: 13.9174256, lng: 79.895822}; // metres away, not kilometres

  it("produces a value with no city in it", () => {
    const value = geoSortGlobalValue(RESTAURANT);
    expect(value).not.toContain("naidupeta");
    expect(value).not.toContain("Naidupeta");
    expect(value.split("|")).toHaveLength(2); // <geohash>|<id>, not <city>|<geohash>|<id>
  });

  it("is blind to a spelling mismatch that hides the restaurant from geoSort", () => {
    // First, prove the reported bug actually reproduces against geoSort: a
    // customer whose address says "Naidupet" gets a range scoped to a
    // different city key than the restaurant's "Naidupeta" ever writes to.
    const customerRange = geoCellRange("Naidupet", geohashEncode(CUSTOMER.lat, CUSTOMER.lng, GEO_QUERY_PRECISION_TIGHT));
    const restaurantValue = geoSortValue(RESTAURANT);
    expect(restaurantValue >= customerRange.startAt && restaurantValue <= customerRange.endAt).toBe(false);

    // Now prove the fix: the same cell, read from the global index instead,
    // finds it regardless of what either side called the city.
    const cell = geohashEncode(CUSTOMER.lat, CUSTOMER.lng, GEO_QUERY_PRECISION_TIGHT);
    const globalRange = geoGlobalCellRange(cell);
    const globalValue = geoSortGlobalValue(RESTAURANT);
    expect(globalValue >= globalRange.startAt && globalValue <= globalRange.endAt).toBe(true);
  });

  it("still will not return a restaurant genuinely far away, with no city check needed", () => {
    // Real cities sit far enough apart that the geohash cell itself excludes
    // them - the earlier "never reaches into another city" test already
    // proves this at the geoSort level; this confirms the global index has
    // the same property for free, since it uses the identical cell math.
    const distant = {id: "n1", name: "Zaika", city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng};
    const cell = geohashEncode(CUSTOMER.lat, CUSTOMER.lng, GEO_QUERY_PRECISION_WIDE);
    const range = geoGlobalCellRange(cell);
    const value = geoSortGlobalValue(distant);
    expect(value >= range.startAt && value <= range.endAt).toBe(false);
  });

  it("writes only when the stored value is actually wrong", () => {
    const current = geoSortGlobalValue(RESTAURANT);
    expect(geoSortGlobalNeedsUpdate(RESTAURANT, current)).toBe(false);
    expect(geoSortGlobalNeedsUpdate(RESTAURANT, undefined)).toBe(true);
    expect(geoSortGlobalNeedsUpdate({...RESTAURANT, lat: 14.5}, current)).toBe(true);
    // Unlike geoSortNeedsUpdate, a city change alone must NOT need an update -
    // the whole point is that this value does not depend on city at all.
    expect(geoSortGlobalNeedsUpdate({...RESTAURANT, city: "Nellore"}, current)).toBe(false);
  });

  it("leaves an unplaceable restaurant out, same as the city-scoped index", () => {
    expect(geoSortGlobalValue({id: "r1", city: "Naidupeta"})).toBe("");
    expect(geoSortGlobalValue({...RESTAURANT, id: ""})).toBe("");
  });

  it("does not rewrite an unplaceable restaurant forever", () => {
    const restaurant = {id: "r1", city: "Naidupeta"};
    expect(geoSortGlobalNeedsUpdate(restaurant, undefined)).toBe(false);
    expect(geoSortGlobalNeedsUpdate(restaurant, "")).toBe(false);
  });
});
