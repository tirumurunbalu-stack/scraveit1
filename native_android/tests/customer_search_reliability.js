#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");

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
  const storage = new Map();
  const elements = new Map();
  const scheduled = new Map();
  const cancelled = new Set();
  let nextTimer = 1;
  const document = {
    documentElement: makeElement(), visibilityState: "visible",
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    querySelector(selector) { return selector === 'meta[name="theme-color"]' ? makeElement() : null; },
    querySelectorAll() { return []; }, addEventListener() {}, createElement() { return makeElement(); },
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  class HTMLFormElement {}
  const context = {
    console, document, localStorage, navigator: { onLine: true }, crypto: webcrypto,
    TextEncoder, AbortController, HTMLFormElement, FormData: global.FormData,
    Image: class Image {}, FEASTLY_FIREBASE: {},
    fetch: async () => { throw new Error("search must not perform an unbounded network request"); },
    setTimeout(callback, delay) { const id = nextTimer++; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout(id) { if (id != null) { cancelled.add(id); scheduled.delete(id); } },
    setInterval: () => nextTimer++, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return nextTimer++; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
  };
  context.window = context;
  context.globalThis = context;
  context.__storage = storage;
  context.__scheduled = scheduled;
  context.__cancelled = cancelled;
  return vm.createContext(context);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`✓ ${message}\n`);
}

const original = fs.readFileSync(customerFile, "utf8");
const marker = "bootstrap();";
const index = original.lastIndexOf(marker);
if (index < 0) throw new Error("Customer bootstrap marker was not found");
const instrumented = original.slice(0, index)
  + "globalThis.__CUSTOMER_SEARCH={state,searchHistoryKey,normalizedRecentSearches,recordRecentSearch,clearRecentSearches,recentSearchMarkup,searchResultMarkup,searchContentMarkup,scheduleSearchUpdate,restaurantsFiltered,searchMatches};"
  + original.slice(index + marker.length);
const context = makeContext();
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });

const api = context.__CUSTOMER_SEARCH;
const { state } = api;

const normalized = Array.from(api.normalizedRecentSearches([
  "  Waffle   Spot ", "waffle spot", "Biryani", "Pizza", "Dosa", "Burger", "Salad", "Dessert", "Coffee", "Extra",
]));
check(normalized[0] === "Waffle Spot" && normalized.filter(value => value.toLowerCase() === "waffle spot").length === 1, "recent search normalization collapses spacing and removes case-insensitive duplicates");
check(normalized.length === 8, "recent search history is bounded to eight terms");

state.session = { uid: "customer-a" };
state.recentSearches = [];
const otherKey = api.searchHistoryKey("customer-b");
context.__storage.set(otherKey, JSON.stringify(["Other account term"]));
api.recordRecentSearch("  Belgian   Waffle ");
api.recordRecentSearch("belgian waffle");
check(state.recentSearches.length === 1 && state.recentSearches[0] === "belgian waffle", "committed searches are deduplicated before persistence");
check(context.__storage.has(api.searchHistoryKey("customer-a")), "recent searches are persisted under the authenticated customer account");
check(JSON.parse(context.__storage.get(otherKey))[0] === "Other account term", "saving search history never overwrites another customer's history");
check(api.recentSearchMarkup().includes('data-action="clear-search-history"') && api.recentSearchMarkup().includes('data-action="recent-search"'), "recent-search chips expose reuse and clear-history controls");
api.clearRecentSearches();
check(JSON.parse(context.__storage.get(api.searchHistoryKey("customer-a"))).length === 0, "clear history affects only the current customer account");

state.syncTimers.catalog = 801;
state.syncTimers.orders = 802;
api.scheduleSearchUpdate();
const firstSearchTimer = state.searchDebounceTimer;
api.scheduleSearchUpdate();
const secondSearchTimer = state.searchDebounceTimer;
check(firstSearchTimer !== secondSearchTimer && context.__cancelled.has(firstSearchTimer), "rapid search input cancels only the preceding search render");
check(state.syncTimers.catalog === 801 && state.syncTimers.orders === 802, "search debounce cannot cancel catalogue or order synchronization");
check(context.__scheduled.get(secondSearchTimer).delay === 180, "search results use a short deterministic debounce interval");

state.profile.addresses = [];
state.profile.selectedAddressId = "";
state.profile.preferences.vegetarian = false;
state.cuisine = "All";
state.diet = "all";
state.homeFilter = "all";
state.sort = "recommended";
state.catalog = {
  "waffle-spot": {
    id: "waffle-spot", name: "The Waffle Spot", city: "Naidupeta", open: true, archived: false,
    cuisines: ["Desserts"], rating: 4.6, ratingCount: 20, etaMin: 20, etaMax: 30,
    menuIndex: [{ id: "item-1", name: "Belgian Chocolate Waffle", description: "Dark chocolate", price: 149, available: true, diet: "veg" }],
  },
  "rice-house": {
    id: "rice-house", name: "Rice House", city: "Naidupeta", open: true, archived: false,
    cuisines: ["Indian"], menuIndex: [{ id: "item-2", name: "Fried Rice", price: 199, available: true, diet: "veg" }],
  },
};
state.catalogLoaded = true;
state.homeStatus = "success";
state.query = "BELGIAN   waffle";
let results = api.restaurantsFiltered();
check(results.length === 1 && results[0].id === "waffle-spot", "search matches dish names without case or spacing sensitivity inside the loaded catalogue window");
state.query = "rcehse";
results = api.restaurantsFiltered();
check(results.length === 1 && results[0].id === "rice-house", "existing ordered-character fuzzy matching remains deterministic and local");

state.catalog = {};
state.catalogLoaded = false;
state.homeStatus = "loadingWithoutCache";
check(api.searchResultMarkup().includes("Loading restaurants for this address"), "search renders a deterministic loading state before catalogue hydration");
state.catalogLoaded = true;
state.homeStatus = "errorWithoutCache";
check(api.searchResultMarkup().includes("Search could not be loaded") && api.searchResultMarkup().includes('data-action="refresh"'), "search renders a deterministic retry state after a catalogue failure");
state.homeStatus = "success";
state.catalog = { "rice-house": { id: "rice-house", name: "Rice House", open: true, cuisines: ["Indian"], menuIndex: [] } };
state.query = "definitely absent";
check(api.searchResultMarkup().includes("Nothing matched") && api.searchResultMarkup().includes('data-action="clear-search"'), "search renders an actionable empty-result state for an unmatched term");

check(!String(api.scheduleSearchUpdate).includes("fetch("), "typing in search never starts a network query");
process.stdout.write("Customer search reliability assertions passed.\n");
