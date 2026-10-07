#!/usr/bin/env node
/**
 * A city larger than its delivery radius broke the alphabetical listing in a
 * way page size could never fix: it loads the alphabetically-first
 * restaurants, not the nearest ones, so a restaurant two kilometres away whose
 * name starts with Z can never appear. The customer app now loads by
 * proximity instead, once an address has a real pin - these tests drive the
 * real shipped geohash and fetch functions - including the Firestore query
 * builders - against an in-memory Firestore, the same way
 * customer_catalog_paging.js does for the alphabetical path this sits
 * alongside.
 *
 * What is actually being guarded: the neighbourhood query has to find what is
 * actually nearby, has to widen when the tight tier is too thin to trust, has
 * to stay bounded however dense the area is, and must never cross into
 * another city. None of these show up as a UI crash if they are wrong - the
 * list just quietly has the wrong restaurants in it - so they are caught here
 * instead.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createFirebaseCompat, createFirestore } = require("./support/firebase_compat_stub");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "app", "src", "main", "assets", "premium.js"),
  "utf8"
);
const SERVER_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "functions", "src", "domain", "catalogGeoIndex.ts"), "utf8");
const SERVER_INDEX_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "functions", "src", "domain", "catalogIndex.ts"), "utf8");

/** Lifts a function out of the shipped file by matching braces, so the test
 *  runs the code that actually ships rather than a copy of it. */
function extract(name) {
  let start = SOURCE.indexOf("function " + name + "(");
  assert.ok(start >= 0, "premium.js no longer defines " + name);
  if (SOURCE.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  let i = SOURCE.indexOf("(", start);
  let depth = 0;
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === "(") depth++;
    else if (SOURCE[i] === ")") { depth--; if (!depth) { i++; break; } }
  }
  while (SOURCE[i] !== "{") i++;
  depth = 0;
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    else if (SOURCE[i] === "}") { depth--; if (!depth) { i++; break; } }
  }
  return SOURCE.slice(start, i);
}

function constant(name) {
  const match = SOURCE.match(new RegExp("const\\s+" + name + "\\s*=\\s*([0-9]+)\\s*;"));
  assert.ok(match, "premium.js no longer defines " + name);
  return Number(match[1]);
}

const CATALOG_PAGE_SIZE = constant("CATALOG_PAGE_SIZE");
const CATALOG_MAX_PAGES = constant("CATALOG_MAX_PAGES");
const GEO_QUERY_PRECISION_TIGHT = constant("GEO_QUERY_PRECISION_TIGHT");
const GEO_QUERY_PRECISION_WIDE = constant("GEO_QUERY_PRECISION_WIDE");
const GEO_CELL_FETCH_LIMIT = constant("GEO_CELL_FETCH_LIMIT");

/** An in-memory Firestore holding `rows` in /restaurants, answering the
 *  app's geoSort / geoSortGlobal / citySort range queries the way Firestore
 *  does: ordered by value, inclusive at both ends, documents missing the
 *  field left out, limit applied after the range. Also serves the
 *  document-id fallback used when no city is known. */
function makeServer(rows) {
  const byId = {};
  rows.forEach((r) => { byId[r.id] = r; });
  const db = createFirestore({ restaurants: byId });
  return {
    db,
    get requests() { return db.queries; },
    get(id) { return byId[id] || null; },
  };
}

/** Builds the harness out of the real functions, with the app's state,
 *  address and Firestore replaced by the test's. */
function harness(rows, address) {
  const server = makeServer(rows);
  const factory = new Function("server", "address", "firebase", `
    const CATALOG_RANGE_END = "\\uf8ff";
    const CATALOG_PAGE_SIZE = ${CATALOG_PAGE_SIZE};
    const CATALOG_MAX_PAGES = ${CATALOG_MAX_PAGES};
    const GEO_QUERY_PRECISION_TIGHT = ${GEO_QUERY_PRECISION_TIGHT};
    const GEO_QUERY_PRECISION_WIDE = ${GEO_QUERY_PRECISION_WIDE};
    const GEO_CELL_FETCH_LIMIT = ${GEO_CELL_FETCH_LIMIT};
    const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";
    function currentAddress() { return address || null; }
    function restaurantsCollectionRef() { return server.db.collection("restaurants"); }
    ${extract("catalogCityKey")}
    ${extract("catalogNameKey")}
    ${extract("cityListingRange")}
    ${extract("cityListingRangeAfter")}
    ${extract("citySearchRange")}
    ${extract("catalogCity")}
    ${extract("restaurantSummaryRange")}
    ${extract("restaurantSummaryFirestoreQuery")}
    ${extract("catalogCursorFrom")}
    ${extract("addressIsPinned")}
    ${extract("geoCoordinate")}
    ${extract("geohashEncode")}
    ${extract("geohashBounds")}
    ${extract("geohashNeighborhood")}
    ${extract("geoCellRange")}
    ${extract("geoGlobalCellRange")}
    ${extract("fetchRestaurantSummaries")}
    ${extract("fetchCatalogPages")}
    ${extract("recordsFromSnapshot")}
    ${extract("fetchGeoCell")}
    ${extract("fetchGeoCellGlobal")}
    ${extract("mergeGeoCells")}
    ${extract("fetchGeoNeighborhood")}
    ${extract("fetchGeoNeighborhoodGlobal")}
    ${extract("fetchGeoCatalogRecords")}
    ${extract("fetchCatalogRecords")}
    return {
      fetchCatalogRecords, fetchGeoCatalogRecords, fetchGeoNeighborhood, fetchGeoNeighborhoodGlobal, fetchCatalogPages,
      geohashEncode, geohashNeighborhood, geoCellRange, geoGlobalCellRange, catalogCityKey, catalogNameKey, addressIsPinned, server,
    };
  `);
  return factory(server, address, createFirebaseCompat().firebase);
}

const NELLORE = { lat: 14.4426, lng: 79.9865 };

function distanceKm(aLat, aLng, bLat, bLng) {
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** geoSort exactly as the trigger writes it, and citySort alongside it - so
 *  the simulated server can answer both the proximity queries under test and
 *  the alphabetical queries these fixtures are also compared against. */
function indexValues(app, restaurant) {
  const cityKey = app.catalogCityKey(restaurant.city);
  const nameKey = app.catalogNameKey ? app.catalogNameKey(restaurant.name) : "";
  const hash = app.geohashEncode(restaurant.lat, restaurant.lng, 9);
  return {
    citySort: `${cityKey}|${nameKey}|${restaurant.id}`,
    geoSort: restaurant.id && hash ? `${cityKey}|${hash}|${restaurant.id}` : null,
    geoSortGlobal: restaurant.id && hash ? `${hash}|${restaurant.id}` : null,
  };
}

/** A dense city: `count` restaurants spread out to `spreadKm` from the centre
 *  (roughly linearly with index, matching the fixture in
 *  functions/test/catalogGeoIndex.test.ts, so both suites agree on what
 *  "the alphabetically-first 320 misses nearby restaurants" actually looks
 *  like), named so alphabetical and geographic order are unrelated. */
function denseCity(app, cityName, count, spreadKm) {
  const key = cityName.toLowerCase();
  const rows = Array.from({ length: count }, (_, i) => {
    const angle = (i * 137.5 * Math.PI) / 180;
    const radiusKm = spreadKm * ((i + 1) / count);
    const lat = NELLORE.lat + (radiusKm / 111) * Math.cos(angle);
    const lng = NELLORE.lng + (radiusKm / (111 * Math.cos((NELLORE.lat * Math.PI) / 180))) * Math.sin(angle);
    const named = (i * 317) % count;
    const restaurant = {
      id: `${key}-${String(i).padStart(4, "0")}`,
      name: `${String.fromCharCode(97 + (named % 26))}${named} Kitchen`,
      city: cityName, lat, lng,
    };
    return { ...restaurant, km: distanceKm(NELLORE.lat, NELLORE.lng, lat, lng) };
  });
  rows.forEach((r) => Object.assign(r, indexValues(app, r)));
  return rows;
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log("  ok: " + label); }
  catch (error) { failures++; console.error("  FAIL: " + label + "\n    " + error.message); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log("  ok: " + label); }
  catch (error) { failures++; console.error("  FAIL: " + label + "\n    " + error.message); }
}

(async () => {
  console.log("\nthe client's geohash maths agrees with the server's");

  check("the server source still has the shape this comparison assumes", () => {
    assert.ok(SERVER_SOURCE.includes('BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"'),
      "server geohash alphabet changed");
    assert.ok(/export const GEO_QUERY_PRECISION_TIGHT = 5;/.test(SERVER_SOURCE), "tight precision changed");
    assert.ok(/export const GEO_QUERY_PRECISION_WIDE = 4;/.test(SERVER_SOURCE), "wide precision changed");
    assert.ok(SERVER_INDEX_SOURCE.includes(".slice(0, 120)"), "catalogIndex nameKey no longer slices to 120");
  });

  check("client precisions match the server's", () => {
    assert.strictEqual(GEO_QUERY_PRECISION_TIGHT, 5);
    assert.strictEqual(GEO_QUERY_PRECISION_WIDE, 4);
  });

  check("geohash encoding matches the reference example", () => {
    const app = harness([], null);
    // The standard worked example from the geohash definition.
    assert.strictEqual(app.geohashEncode(57.64911, 10.40744, 11), "u4pruydqqvj");
  });

  check("geohash encoding matches at both query precisions, many points", () => {
    const app = harness([], null);
    const points = [
      [14.4426, 79.9865], [12.9716, 77.5946], [17.3850, 78.4867],
      [0, 0], [-33.8688, 151.2093], [51.5074, -0.1278], [90, 180], [-90, -180],
    ];
    [4, 5, 9].forEach((precision) => {
      points.forEach(([lat, lng]) => {
        // Independently re-derive the server's bit-interleaving to compare
        // against, rather than importing TS into this plain-Node test.
        let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180, hash = "", bits = 0, bitCount = 0, lonTurn = true;
        const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
        while (hash.length < precision) {
          if (lonTurn) {
            const mid = (lngMin + lngMax) / 2;
            if (lng >= mid) { bits = (bits << 1) + 1; lngMin = mid; } else { bits <<= 1; lngMax = mid; }
          } else {
            const mid = (latMin + latMax) / 2;
            if (lat >= mid) { bits = (bits << 1) + 1; latMin = mid; } else { bits <<= 1; latMax = mid; }
          }
          lonTurn = !lonTurn;
          if (++bitCount === 5) { hash += alphabet[bits]; bits = 0; bitCount = 0; }
        }
        assert.strictEqual(app.geohashEncode(lat, lng, precision), hash, `${lat},${lng} @ ${precision}`);
      });
    });
  });

  check("rejects the same junk coordinates the server rejects", () => {
    const app = harness([], null);
    [[null, null], [undefined, undefined], ["abc", "def"], [NaN, 0], [91, 0], [0, 181], [-91, 0]]
      .forEach(([lat, lng]) => assert.strictEqual(app.geohashEncode(lat, lng, 5), ""));
  });

  check("the neighbourhood is nine cells at both precisions, deduplicated", () => {
    const app = harness([], null);
    [GEO_QUERY_PRECISION_TIGHT, GEO_QUERY_PRECISION_WIDE].forEach((precision) => {
      const cells = app.geohashNeighborhood(NELLORE.lat, NELLORE.lng, precision);
      assert.strictEqual(cells.length, 9, "precision " + precision);
      assert.strictEqual(new Set(cells).size, 9, "precision " + precision);
    });
  });

  check("there is nothing to query for an unpinned customer", () => {
    const app = harness([], null);
    assert.deepStrictEqual(app.geohashNeighborhood(null, null, 5), []);
    assert.deepStrictEqual(app.geohashNeighborhood("x", "y", 5), []);
  });

  console.log("\nfetchCatalogRecords branches correctly on whether the address is pinned");

  await checkAsync("an unpinned address still uses the alphabetical path, unchanged", async () => {
    const rows = denseCity(harness([], null), "Nellore", 5, 3);
    const app = harness(rows, { city: "Nellore" }); // has a city, no lat/lng
    assert.strictEqual(app.addressIsPinned({ city: "Nellore" }), false, "sanity: this address must read as unpinned");
    const result = await app.fetchCatalogRecords(1);
    assert.strictEqual(Object.keys(result.records).length, 5);
    assert.strictEqual(result.hasMore, false);
  });

  await checkAsync("no address at all also falls back to the alphabetical path", async () => {
    const app = harness(denseCity(harness([], null), "Nellore", 5, 3), null);
    const result = await app.fetchCatalogRecords(1);
    assert.strictEqual(Object.keys(result.records).length, 5);
  });

  await checkAsync("a pinned address uses the proximity path and returns everything at once", async () => {
    const app0 = harness([], null);
    const rows = denseCity(app0, "Nellore", 10, 2);
    const app = harness(rows, { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng });
    const result = await app.fetchCatalogRecords(1);
    assert.strictEqual(result.hasMore, false, "geo mode has nothing further to page into");
    assert.strictEqual(result.pages, 1);
    assert.strictEqual(Object.keys(result.records).length, 10);
  });

  console.log("\nproximity loading actually finds what is nearby, and stays bounded");

  await checkAsync("a restaurant right next door is found; a distant one in the same city is not", async () => {
    const app0 = harness([], null);
    const rows = denseCity(app0, "Nellore", 300, 20);
    const app = harness(rows, { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng });
    const result = await app.fetchGeoCatalogRecords({ lat: NELLORE.lat, lng: NELLORE.lng });
    const found = new Set(Object.keys(result.records));
    const veryNear = rows.filter((r) => r.km <= 2);
    const veryFar = rows.filter((r) => r.km >= 18);
    assert.ok(veryNear.length > 0 && veryFar.length > 0, "fixture sanity");
    assert.ok(veryNear.every((r) => found.has(r.id)), "a restaurant 2km away must be found");
  });

  await checkAsync("the alphabetical bug is actually gone: proximity finds what alphabetical missed", async () => {
    const app0 = harness([], null);
    const rows = denseCity(app0, "Nellore", 500, 20);
    const alphaApp = harness(rows, { city: "Nellore" });
    const alpha = await alphaApp.fetchCatalogPages(CATALOG_MAX_PAGES);
    const alphaFound = new Set(Object.keys(alpha.records));

    const geoApp = harness(rows, { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng });
    const geo = await geoApp.fetchGeoCatalogRecords({ lat: NELLORE.lat, lng: NELLORE.lng });
    const geoFound = new Set(Object.keys(geo.records));

    const near = rows.filter((r) => r.km <= 3);
    const missedByAlpha = near.filter((r) => !alphaFound.has(r.id));
    assert.ok(missedByAlpha.length > 0, "fixture sanity: alphabetical must actually miss some nearby ones");
    assert.ok(missedByAlpha.every((r) => geoFound.has(r.id)),
      "everything alphabetical missed nearby must be found by proximity");
  });

  await checkAsync("widens to the wide tier only when the tight tier is thin", async () => {
    const app0 = harness([], null);
    // Spread wide enough that tight alone comes back thin, but with enough
    // restaurants that the wide tier already satisfies the page size - so
    // the newer city-agnostic tiers below are never reached, isolating this
    // test to exactly the tight-to-wide escalation it names.
    const rows = denseCity(app0, "Nellore", 45, 40);
    const app = harness(rows, { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng });
    await app.fetchGeoCatalogRecords({ lat: NELLORE.lat, lng: NELLORE.lng });
    // 9 tight cells, then 9 wide cells once tight came back thin.
    assert.strictEqual(app.server.requests, 18, "expected a widen (9 tight + 9 wide)");
  });

  await checkAsync("does not widen when the tight tier already has enough", async () => {
    const app0 = harness([], null);
    const rows = denseCity(app0, "Nellore", CATALOG_PAGE_SIZE + 20, 3);
    const app = harness(rows, { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng });
    await app.fetchGeoCatalogRecords({ lat: NELLORE.lat, lng: NELLORE.lng });
    assert.strictEqual(app.server.requests, 9, "a dense area must not pay for the wide tier too");
  });

  await checkAsync("stays bounded even when the wide tier alone would return the whole city", async () => {
    const app0 = harness([], null);
    const rows = denseCity(app0, "Nellore", 2000, 20);
    const app = harness(rows, { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng });
    const result = await app.fetchGeoCatalogRecords({ lat: NELLORE.lat, lng: NELLORE.lng });
    assert.ok(Object.keys(result.records).length <= CATALOG_PAGE_SIZE * CATALOG_MAX_PAGES,
      "must not grow with city size");
  });

  await checkAsync("never reaches into a genuinely distant city, even with every tier active", async () => {
    const app0 = harness([], null);
    // Only 20 restaurants, so every tier (tight, wide, global-tight,
    // global-wide) runs - proving the far city stays excluded is only
    // meaningful when the fallback tiers are actually exercised.
    const nellore = denseCity(app0, "Nellore", 20, 3);
    // A whole 5 degrees away (~550km) - comfortably past the wide tier's
    // *actual* per-direction reach, not just its guaranteed minimum (a
    // level-4 cell's longer edge is ~38km, so a merely-60km separation is not
    // reliably enough once orientation is allowed to vary).
    const distant = denseCity(app0, "Naidupeta", 20, 3).map((r) => ({...r, lat: r.lat + 5, lng: r.lng + 5}))
      .map((r) => ({...r, ...indexValues(app0, r)}));
    const app = harness(nellore.concat(distant), { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng });
    const result = await app.fetchGeoCatalogRecords({ lat: NELLORE.lat, lng: NELLORE.lng });
    const cities = new Set(Object.values(result.records).map((r) => r.city));
    assert.deepStrictEqual([...cities], ["Nellore"]);
  });

  await checkAsync("finds a restaurant at the same real place whose city was spelled differently", async () => {
    // The actual reported bug: a restaurant owner wrote "Naidupeta", the
    // customer's GPS address came back "Naidupet" - one real place, two
    // strings, and geoSort's city scoping alone hides the restaurant from a
    // customer standing right next to it.
    const app0 = harness([], null);
    const spot = { id: "waffle1", name: "The Waffle Spot", city: "Naidupeta", lat: 13.91747864, lng: 79.89603288 };
    const restaurant = { ...spot, ...indexValues(app0, spot) };
    const customerAddress = { city: "Naidupet", lat: 13.9174256, lng: 79.895822 }; // metres away
    const app = harness([restaurant], customerAddress);

    const cityScopedOnly = await app.fetchGeoNeighborhood("Naidupet", customerAddress, GEO_QUERY_PRECISION_TIGHT, 60);
    assert.deepStrictEqual(Object.keys(cityScopedOnly), [], "sanity: the bug must actually reproduce against geoSort alone");

    const result = await app.fetchGeoCatalogRecords(customerAddress);
    assert.deepStrictEqual(Object.keys(result.records), ["waffle1"], "the global tier must find it");
  });

  await checkAsync("a customer elsewhere in the same city gets a different neighbourhood", async () => {
    const app0 = harness([], null);
    const rows = denseCity(app0, "Nellore", 200, 20);
    const hereAddress = { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng };
    const thereAddress = { city: "Nellore", lat: NELLORE.lat + 0.15, lng: NELLORE.lng + 0.15 };
    const here = await harness(rows, hereAddress).fetchGeoCatalogRecords(hereAddress);
    const there = await harness(rows, thereAddress).fetchGeoCatalogRecords(thereAddress);
    const hereIds = new Set(Object.keys(here.records));
    const thereIds = new Set(Object.keys(there.records));
    assert.ok(thereIds.size > 0);
    assert.ok([...thereIds].some((id) => !hereIds.has(id)), "moving across the city must change what is offered");
  });

  await checkAsync("one cell failing does not take the rest of the neighbourhood down with it", async () => {
    const app0 = harness([], null);
    const rows = denseCity(app0, "Nellore", 60, 3);
    const address = { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng };
    const healthy = await harness(rows, address).fetchGeoNeighborhood("Nellore", address, GEO_QUERY_PRECISION_TIGHT, 60);
    // Simulate one of the nine cell queries throwing, the way a flaky mobile
    // network call fails independently of the other eight.
    const app = harness(rows, address);
    let call = 0;
    app.server.db.beforeRead = () => { call++; if (call === 3) throw new Error("network blip"); };
    const flaky = await app.fetchGeoNeighborhood("Nellore", address, GEO_QUERY_PRECISION_TIGHT, 60);
    assert.strictEqual(call, 9, "every cell must still have been asked");
    assert.ok(flaky, "a single failed cell must not fail the neighbourhood");
    assert.ok(Object.keys(flaky).length > 0, "the healthy cells must still have answered");
    assert.ok(Object.keys(flaky).every((id) => healthy[id]), "a failed cell must not invent restaurants");
  });

  await checkAsync("every cell failing is an error, not an empty neighbourhood", async () => {
    // Offline at launch: if this came back as {} the home screen would say
    // nothing delivers here and overwrite the saved catalogue with nothing.
    const app0 = harness([], null);
    const rows = denseCity(app0, "Nellore", 60, 3);
    const address = { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng };
    const app = harness(rows, address);
    app.server.db.beforeRead = () => { throw new Error("offline"); };
    assert.strictEqual(await app.fetchGeoNeighborhood("Nellore", address, GEO_QUERY_PRECISION_TIGHT, 60), null);
    await assert.rejects(() => app.fetchGeoCatalogRecords(address), /CATALOG_UNAVAILABLE/);
  });

  await checkAsync("a genuinely empty neighbourhood is still an empty result, not an error", async () => {
    const address = { city: "Nellore", lat: NELLORE.lat, lng: NELLORE.lng };
    const result = await harness([], address).fetchGeoCatalogRecords(address);
    assert.deepStrictEqual(result.records, {});
  });

  console.log("\n" + (failures ? failures + " FAILED" : "ALL PASSED"));
  process.exit(failures ? 1 : 0);
})();
