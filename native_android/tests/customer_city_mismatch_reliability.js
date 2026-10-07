#!/usr/bin/env node
"use strict";
/**
 * The real, reported bug this guards against: a customer's saved address had
 * city "Naidupet" (from GPS reverse-geocoding); the restaurant next door was
 * onboarded under "Naidupeta". The fetch layer was fixed to find it anyway
 * (see catalogGeoIndex.ts's geoSortGlobal and customer_catalog_geo.js) - but
 * restaurantsFiltered() and restaurantsAtAddress() each ran their OWN,
 * independent city-string equality check on the way to the screen, silently
 * discarding the very restaurant the fetch fix had just found. The fetch
 * layer's own tests could never catch this: they stop at "the record was
 * fetched into state.catalog", and this bug lived one layer further down,
 * between the catalogue and what actually renders.
 *
 * This loads the real premium.js into a VM (the same technique
 * customer_search_reliability.js already uses for restaurantsFiltered) and
 * drives the real functions directly, so a future change that reintroduces
 * an exact-city-string requirement anywhere in the display path fails this
 * test rather than shipping silently again.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { createFirebaseCompat } = require("./support/firebase_compat_stub");

const customerFile = path.resolve(__dirname, "..", "app", "src", "main", "assets", "premium.js");

function makeElement() {
  return {
    innerHTML: "", value: "", content: "", dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
  };
}

function makeContext() {
  const elements = new Map();
  const document = {
    documentElement: makeElement(), visibilityState: "visible",
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    querySelector(selector) { return selector === 'meta[name="theme-color"]' ? makeElement() : null; },
    querySelectorAll() { return []; }, addEventListener() {}, createElement() { return makeElement(); },
  };
  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  class HTMLFormElement {}
  const context = {
    console, document, localStorage, navigator: { onLine: true }, crypto: webcrypto,
    TextEncoder, AbortController, HTMLFormElement, FormData: global.FormData,
    Image: class Image {}, FEASTLY_FIREBASE: {}, firebase: createFirebaseCompat().firebase,
    fetch: async () => { throw new Error("this test must never perform a network request"); },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return 0; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
  };
  context.window = context;
  context.globalThis = context;
  return vm.createContext(context);
}

let failures = 0;
function check(condition, message) {
  if (condition) { process.stdout.write(`✓ ${message}\n`); return; }
  failures++;
  process.stdout.write(`✗ ${message}\n`);
}

const original = fs.readFileSync(customerFile, "utf8");
const marker = "bootstrap();";
const index = original.lastIndexOf(marker);
if (index < 0) throw new Error("Customer bootstrap marker was not found");
const instrumented = original.slice(0, index)
  + "globalThis.__CUSTOMER_CITY={state,restaurantsFiltered,restaurantsAtAddress};"
  + original.slice(index + marker.length);
const context = makeContext();
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });

const api = context.__CUSTOMER_CITY;
const { state } = api;

/** The exact real-world shapes involved in the reported bug. */
const WAFFLE_SPOT = {
  id: "waffle-spot", name: "The Waffle Spot", city: "Naidupeta", open: true, archived: false,
  lat: 13.91747864, lng: 79.89603288, cuisines: ["Desserts"], menuIndex: [],
};
const MISMATCHED_ADDRESS = { city: "Naidupet", lat: 13.9174256, lng: 79.895822 };

function resetState() {
  state.profile.addresses = [MISMATCHED_ADDRESS];
  state.profile.selectedAddressId = "";
  state.profile.preferences.vegetarian = false;
  state.cuisine = "All"; state.diet = "all"; state.homeFilter = "all";
  state.sort = "recommended"; state.query = "";
  state.catalogLoaded = true; state.homeStatus = "success";
}

resetState();
state.catalog = { "waffle-spot": { ...WAFFLE_SPOT } };
check(
  api.restaurantsFiltered().some((r) => r.id === "waffle-spot"),
  "a pinned customer sees a restaurant whose city was spelled differently, once it is in the fetched catalogue",
);
check(
  api.restaurantsAtAddress().some((r) => r.id === "waffle-spot"),
  "the same holds for the category-source list restaurantsAtAddress() feeds",
);

resetState();
state.catalog = {
  "waffle-spot": { ...WAFFLE_SPOT },
  "far-away": { ...WAFFLE_SPOT, id: "far-away", name: "Somewhere Else", city: "Nellore", lat: 14.4426, lng: 79.9865 },
};
check(
  !api.restaurantsFiltered().some((r) => r.id === "far-away"),
  "a genuinely distant restaurant is still excluded - real distance is the gate, not a relaxed city check",
);

resetState();
state.profile.addresses = [{ city: "Naidupet" }]; // no lat/lng at all: unpinned
state.catalog = { "waffle-spot": { ...WAFFLE_SPOT } };
check(
  !api.restaurantsFiltered().some((r) => r.id === "waffle-spot"),
  "without a pin there is no distance to check yet, so the city string is still the only scoping available",
);

resetState();
state.catalog = { "waffle-spot": { ...WAFFLE_SPOT, archived: true } };
check(
  !api.restaurantsFiltered().some((r) => r.id === "waffle-spot"),
  "an archived restaurant stays excluded regardless of how city matching is relaxed",
);

process.stdout.write(failures ? `${failures} FAILED\n` : "ALL PASSED\n");
process.exit(failures ? 1 : 0);
