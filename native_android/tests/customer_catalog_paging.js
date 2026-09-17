#!/usr/bin/env node
/**
 * The customer app used to download up to 100 restaurants and do everything on
 * the device. It now walks one city a page at a time through the citySort
 * index, so these tests drive the real shipped functions against a simulated
 * Firebase range query.
 *
 * What is actually being guarded: paging a live catalogue must show every
 * restaurant exactly once. A gap hides an open restaurant from a customer who
 * would have ordered from it, and a repeat is just as wrong on the way to
 * finding that out. Neither is visible in the UI - the list simply looks
 * short - so it has to be caught here.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "app", "src", "main", "assets", "premium.js"),
  "utf8"
);

/** Lifts a function out of the shipped file by matching braces, so the test
 *  runs the code that actually ships rather than a copy of it. */
function extract(name) {
  let start = SOURCE.indexOf("function " + name + "(");
  assert.ok(start >= 0, "premium.js no longer defines " + name);
  // Keep an `async` prefix: dropping it turns the function's own `await` into
  // a syntax error rather than anything the test could report usefully.
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

/** A stand-in Firebase that answers an orderBy=citySort range query the same
 *  way the REST API does: ordered by value, inclusive at both ends, and
 *  limitToFirst applied after the range. */
function makeServer(rows) {
  let requests = 0;
  return {
    get requests() { return requests; },
    query(parameters) {
      requests++;
      const limit = Number(parameters.limitToFirst);
      const out = {};
      // Without a city the app falls back to ordering by key, which is what
      // this branch models; otherwise it is a citySort range.
      const byKey = parameters.orderBy === '"$key"';
      const field = byKey ? "id" : "citySort";
      const startAt = byKey ? "" : JSON.parse(parameters.startAt);
      const endAt = byKey ? "￿" : JSON.parse(parameters.endAt);
      rows.slice()
        .sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0))
        .filter(r => r[field] >= startAt && r[field] <= endAt)
        .slice(0, limit)
        .forEach(r => { out[r.id] = r; });
      return out;
    },
  };
}

/** Builds the paging harness out of the real functions, with the app's state,
 *  address and network replaced by the test's. */
function harness(rows, city) {
  const server = makeServer(rows);
  const factory = new Function("server", "city", `
    const CATALOG_RANGE_END = "\\uf8ff";
    const CATALOG_PAGE_SIZE = ${CATALOG_PAGE_SIZE};
    const CATALOG_MAX_PAGES = ${CATALOG_MAX_PAGES};
    function currentAddress() { return city ? {city} : null; }
    ${extract("catalogCityKey")}
    ${extract("catalogNameKey")}
    ${extract("cityListingRange")}
    ${extract("cityListingRangeAfter")}
    ${extract("citySearchRange")}
    ${extract("catalogCity")}
    ${extract("restaurantSummaryQuery")}
    ${extract("catalogCursorFrom")}
    async function fetchRestaurantSummaries(cursor) {
      return server.query(restaurantSummaryQuery(cursor));
    }
    ${extract("fetchCatalogPages")}
    return {fetchCatalogPages, restaurantSummaryQuery, citySearchRange, catalogCursorFrom,
            catalogCityKey, catalogNameKey, server};
  `);
  return factory(server, city);
}

/** `count` restaurants in one city, named so they sort predictably. */
function city(name, count, offset) {
  const key = name.toLowerCase();
  return Array.from({length: count}, (_, i) => {
    const n = String((offset || 0) + i).padStart(4, "0");
    return {id: `${key}-${n}`, name: `Place ${n}`, city: name, citySort: `${key}|place-${n}|${key}-${n}`};
  });
}

/** The word-index helpers, lifted out of the shipped file on their own. */
function tokenHelpers() {
  return new Function(`
    const CATALOG_RANGE_END = "\\uf8ff";
    ${extract("catalogCityKey")}
    ${extract("searchTokenRange")}
    ${extract("restaurantIdFromTokenKey")}
    return {searchTokenRange, restaurantIdFromTokenKey};
  `)();
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
  console.log("\ncatalogue paging walks a city exactly once");

  await checkAsync("a city smaller than one page comes back in a single request", async () => {
    const app = harness(city("Nellore", 5), "Nellore");
    const result = await app.fetchCatalogPages(1);
    assert.strictEqual(Object.keys(result.records).length, 5);
    assert.strictEqual(result.hasMore, false, "a short page must not offer more");
    assert.strictEqual(app.server.requests, 1);
  });

  await checkAsync("a city larger than one page reports that there is more", async () => {
    const app = harness(city("Nellore", CATALOG_PAGE_SIZE * 3), "Nellore");
    const result = await app.fetchCatalogPages(1);
    assert.strictEqual(Object.keys(result.records).length, CATALOG_PAGE_SIZE);
    assert.strictEqual(result.hasMore, true);
    assert.ok(result.cursor, "a resumable page must hand back a cursor");
  });

  await checkAsync("walking every page returns each restaurant exactly once", async () => {
    const rows = city("Nellore", CATALOG_PAGE_SIZE * 4 + 7);
    const app = harness(rows, "Nellore");
    const result = await app.fetchCatalogPages(CATALOG_MAX_PAGES);
    const ids = Object.keys(result.records);
    assert.strictEqual(ids.length, rows.length, "every restaurant in the city must be present");
    assert.strictEqual(new Set(ids).size, ids.length, "no restaurant may appear twice");
    assert.strictEqual(result.hasMore, false, "the end of the city must not offer more");
  });

  await checkAsync("a page boundary landing exactly on the last row still terminates", async () => {
    const rows = city("Nellore", CATALOG_PAGE_SIZE);
    const app = harness(rows, "Nellore");
    const result = await app.fetchCatalogPages(CATALOG_MAX_PAGES);
    assert.strictEqual(Object.keys(result.records).length, CATALOG_PAGE_SIZE);
    assert.strictEqual(result.hasMore, false);
    // One request for the full page, one that comes back holding only the
    // replayed cursor row and proves there is nothing after it.
    assert.ok(app.server.requests <= 2, "must not keep asking past the end (" + app.server.requests + " requests)");
  });

  await checkAsync("however large the city, a refresh stays bounded", async () => {
    const app = harness(city("Nellore", CATALOG_PAGE_SIZE * 50), "Nellore");
    const result = await app.fetchCatalogPages(999);
    assert.strictEqual(result.pages, CATALOG_MAX_PAGES, "the page cap must hold");
    assert.strictEqual(app.server.requests, CATALOG_MAX_PAGES);
    assert.strictEqual(result.hasMore, false, "at the cap the app must stop offering more");
  });

  await checkAsync("a refresh rebuilds exactly the pages the customer had open", async () => {
    const app = harness(city("Nellore", CATALOG_PAGE_SIZE * 6), "Nellore");
    const result = await app.fetchCatalogPages(3);
    assert.strictEqual(result.pages, 3);
    assert.strictEqual(Object.keys(result.records).length, CATALOG_PAGE_SIZE * 3,
      "a customer three pages deep must not have the list shrink under them");
    assert.strictEqual(result.hasMore, true, "and must still be able to keep going");
  });

  console.log("\none city never leaks into another");

  await checkAsync("paging Nellore never returns a Naidupeta restaurant", async () => {
    const rows = city("Nellore", 60).concat(city("Naidupeta", 60)).concat(city("Tirupati", 60));
    const app = harness(rows, "Nellore");
    const result = await app.fetchCatalogPages(CATALOG_MAX_PAGES);
    const cities = new Set(Object.values(result.records).map(r => r.city));
    assert.deepStrictEqual([...cities], ["Nellore"]);
    assert.strictEqual(Object.keys(result.records).length, 60);
  });

  await checkAsync("a city whose name is a prefix of another stays separate", async () => {
    // "Nellore" is a prefix of "Nelloreville"; the | terminator is what keeps
    // the ranges apart, and dropping it would silently merge the two cities.
    const rows = city("Nellore", 3).concat(city("Nelloreville", 3));
    const app = harness(rows, "Nellore");
    const result = await app.fetchCatalogPages(1);
    assert.deepStrictEqual(Object.values(result.records).map(r => r.city), ["Nellore", "Nellore", "Nellore"]);
  });

  await checkAsync("differently spelled versions of one city are treated as that city", async () => {
    const rows = city("Nellore", 2).concat([
      {id: "x1", name: "Alpha", city: "nellore", citySort: "nellore|alpha|x1"},
      {id: "x2", name: "Beta", city: " NELLORE ", citySort: "nellore|beta|x2"},
    ]);
    const app = harness(rows, "Nellore");
    const result = await app.fetchCatalogPages(1);
    assert.strictEqual(Object.keys(result.records).length, 4);
  });

  console.log("\nsearching reaches the whole city, not just what was downloaded");

  await checkAsync("a restaurant well past the loaded pages is still findable", async () => {
    const rows = city("Nellore", CATALOG_PAGE_SIZE * 5).concat([
      {id: "zz", name: "Zaika Grill", city: "Nellore", citySort: "nellore|zaika-grill|zz"},
    ]);
    const app = harness(rows, "Nellore");
    const firstPage = await app.fetchCatalogPages(1);
    assert.ok(!firstPage.records.zz, "the test is pointless if it is on the first page");

    const range = app.citySearchRange("Nellore", "Zaika");
    const found = app.server.query({
      orderBy: '"citySort"', startAt: JSON.stringify(range.startAt),
      endAt: JSON.stringify(range.endAt), limitToFirst: String(CATALOG_PAGE_SIZE),
    });
    assert.deepStrictEqual(Object.keys(found), ["zz"]);
  });

  await checkAsync("search stays inside the customer's city", async () => {
    const rows = [
      {id: "a", name: "Zaika Grill", city: "Nellore", citySort: "nellore|zaika-grill|a"},
      {id: "b", name: "Zaika Grill", city: "Tirupati", citySort: "tirupati|zaika-grill|b"},
    ];
    const app = harness(rows, "Nellore");
    const range = app.citySearchRange("Nellore", "zaika");
    const found = app.server.query({
      orderBy: '"citySort"', startAt: JSON.stringify(range.startAt),
      endAt: JSON.stringify(range.endAt), limitToFirst: "40",
    });
    assert.deepStrictEqual(Object.keys(found), ["a"]);
  });

  console.log("\nthe query itself");

  check("a customer with no address does not page", () => {
    const app = harness(city("Nellore", 100), "");
    const parameters = app.restaurantSummaryQuery("nellore|place-0001|x");
    assert.strictEqual(parameters.orderBy, '"$key"',
      "without a city there is no range, so a cursor must not be pretended to work");
    assert.strictEqual(parameters.limitToFirst, String(CATALOG_PAGE_SIZE));
  });

  await checkAsync("and is never offered more restaurants it cannot fetch", async () => {
    const app = harness(city("Nellore", CATALOG_PAGE_SIZE * 3), "");
    const result = await app.fetchCatalogPages(CATALOG_MAX_PAGES);
    assert.strictEqual(result.hasMore, false, "a dead 'Show more' button must not be shown");
    assert.strictEqual(app.server.requests, 1, "and it must not re-fetch the same page");
  });

  check("a resumed page asks for one extra row to cover the replayed cursor", () => {
    const app = harness(city("Nellore", 100), "Nellore");
    assert.strictEqual(app.restaurantSummaryQuery("").limitToFirst, String(CATALOG_PAGE_SIZE));
    assert.strictEqual(app.restaurantSummaryQuery("nellore|a|b").limitToFirst, String(CATALOG_PAGE_SIZE + 1));
  });

  check("a corrupt cursor falls back to the city instead of returning nothing", () => {
    const app = harness(city("Nellore", 10), "Nellore");
    const good = app.restaurantSummaryQuery("");
    ["", "!!!", "tirupati|a|b", "zzzzz"].forEach(cursor => {
      const parameters = app.restaurantSummaryQuery(cursor);
      assert.strictEqual(parameters.startAt, good.startAt, "cursor " + JSON.stringify(cursor));
      assert.strictEqual(parameters.endAt, good.endAt, "cursor " + JSON.stringify(cursor));
    });
  });

  check("restaurants with no index value yet do not become a cursor", () => {
    const app = harness([], "Nellore");
    assert.strictEqual(app.catalogCursorFrom({a: {}, b: {citySort: ""}, c: null}), "");
    assert.strictEqual(app.catalogCursorFrom({a: {citySort: "nellore|a|a"}, b: {}}), "nellore|a|a");
  });

  console.log("\nthe client's index maths agrees with the server's");
  // The app and Functions address the same citySort range and the same
  // searchTokens keys. A divergence here does not show up as a wrong number -
  // it silently returns the wrong restaurants, or none at all.
  {
    const indexSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "functions", "src", "domain", "catalogIndex.ts"), "utf8");
    const tokenSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "functions", "src", "domain", "catalogSearchTokens.ts"), "utf8");
    const dispatchSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "functions", "src", "domain", "dispatch.ts"), "utf8");

    // The server rules these tests compare against, restated. The assertions
    // directly below keep this restatement honest: if the real source stops
    // matching its shape, they fail rather than quietly comparing nothing.
    check("the server source still has the shape these comparisons assume", () => {
      assert.ok(dispatchSource.includes(".slice(0, 80)"), "dispatch cityKey no longer slices to 80");
      assert.ok(dispatchSource.includes('|| "unknown"'), "dispatch cityKey lost its unknown fallback");
      assert.ok(indexSource.includes(".slice(0, 120)"), "catalogIndex nameKey no longer slices to 120");
      assert.ok(indexSource.includes("`${city}|${name}|${id}`"), "citySort is no longer city|name|id");
      assert.ok(tokenSource.includes("`${token}|${String(restaurantId"), "token key is no longer token|id");
      assert.ok(/const MAX_TOKEN_LENGTH = 40;/.test(tokenSource), "token length cap is no longer 40");
      assert.ok(/split\(\/\[\^a-z0-9\]\+\/\)/.test(tokenSource), "tokenizer no longer splits on non-alphanumerics");
    });

    const app = harness([], "Nellore");
    const serverCityKey = v => String(v ?? "").trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unknown";
    const serverNameKey = v => String(v ?? "").trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);

    check("city keys match", () => {
      ["Nellore", "  nellore  ", "NAIDUPETA", "New Delhi", "Bengaluru/Bangalore", "", "   ", "x".repeat(200)]
        .forEach(v => assert.strictEqual(app.catalogCityKey(v), serverCityKey(v), JSON.stringify(v.slice(0, 20))));
    });

    check("name keys match", () => {
      ["The Waffle Spot", "Highway cross", "Sri Krishna Bhavan & Co.", "  spaced  ", "ÀccentÉd", "123", "", "y".repeat(200)]
        .forEach(v => assert.strictEqual(app.catalogNameKey(v), serverNameKey(v), JSON.stringify(v.slice(0, 20))));
    });

    check("listing and search ranges match", () => {
      ["Nellore", "Naidupeta", ""].forEach(city => {
        assert.deepStrictEqual(app.citySearchRange(city, ""),
          {startAt: serverCityKey(city) + "|", endAt: serverCityKey(city) + "|"},
          "empty query must fall back to the whole city: " + JSON.stringify(city));
        ["waffle", "high", "The"].forEach(query => {
          const prefix = serverNameKey(query);
          assert.deepStrictEqual(app.citySearchRange(city, query), {
            startAt: serverCityKey(city) + "|" + prefix,
            endAt: serverCityKey(city) + "|" + prefix + "",
          }, JSON.stringify(city) + "/" + JSON.stringify(query));
        });
      });
    });

    check("word lookup ranges match", () => {
      const app2 = tokenHelpers();
      const serverRange = (city, query) => {
        const prefix = String(query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
          .map(t => t.slice(0, 40))[0];
        return prefix ? {cityKey: serverCityKey(city), startAt: prefix, endAt: prefix + ""} : null;
      };
      ["waffle", "waffle spot", "WAFFLE", "  waffle  ", "", "!!!", "z".repeat(60), "99"].forEach(query => {
        assert.deepStrictEqual(app2.searchTokenRange("Nellore", query), serverRange("Nellore", query),
          JSON.stringify(query.slice(0, 20)));
      });
    });

    check("the restaurant id is read out of a key the same way", () => {
      const app2 = tokenHelpers();
      const serverId = key => {
        const value = String(key ?? ""), separator = value.indexOf("|");
        return separator < 0 ? "" : value.slice(separator + 1);
      };
      ["waffle|spot1", "waffle|id|with|pipes", "malformed", "", "|leading"].forEach(key => {
        assert.strictEqual(app2.restaurantIdFromTokenKey(key), serverId(key), JSON.stringify(key));
      });
      assert.strictEqual(app2.restaurantIdFromTokenKey(null), serverId(null));
    });
  }

  console.log("\n" + (failures ? failures + " FAILED" : "ALL PASSED"));
  process.exit(failures ? 1 : 0);
})();
