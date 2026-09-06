#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { webcrypto } = require("crypto");

const nativeRoot = path.resolve(__dirname, "..");
const customerSourcePath = path.join(nativeRoot, "app", "src", "main", "assets", "premium.js");
const rulesPath = path.resolve(nativeRoot, "..", "firebase", "feastly-realtime-database-rules.json");
const original = fs.readFileSync(customerSourcePath, "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function element() {
  return {
    innerHTML: "", value: "", content: "", dataset: {}, scrollTop: 0,
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, bottom: 800 }; },
  };
}

function contextWith(seed, online, fetchImpl) {
  const storage = new Map(Object.entries(seed || {}).map(([key, value]) => [key, String(value)]));
  const elements = new Map();
  const documentElement = element();
  documentElement.clientHeight = 800;
  const document = {
    documentElement, visibilityState: "visible",
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelector(selector) { return selector === 'meta[name="theme-color"]' ? element() : null; },
    querySelectorAll() { return []; }, addEventListener() {}, createElement() { return element(); },
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  class HTMLFormElement {}
  const context = {
    console, document, localStorage, navigator: { onLine: online }, performance,
    crypto: webcrypto, TextEncoder, AbortController, HTMLFormElement, FormData: global.FormData,
    Image: class Image {}, FEASTLY_FIREBASE: { apiKey: "test", databaseUrl: "https://example.invalid" },
    fetch: fetchImpl, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return 1; }, scrollTo() {}, scrollY: 0, innerHeight: 800,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
  };
  context.window = context;
  context.globalThis = context;
  return { context: vm.createContext(context), elements };
}

function instrument(source) {
  const marker = "bootstrap();";
  const index = source.lastIndexOf(marker);
  assert(index >= 0, "customer bootstrap marker missing");
  return source.slice(0, index)
    + "globalThis.__customer={state,render,restoreHomeCache};globalThis.__bootPromise=bootstrap();"
    + source.slice(index + marker.length);
}

async function run() {
  const now = Date.now();
  const session = { uid: "cache-customer", email: "cache@example.test", idToken: "token", refreshToken: "refresh", expiresAt: now + 3600000 };
  const profile = {
    name: "Cache Customer", email: "cache@example.test", phone: "9999999999",
    selectedAddressId: "home", favourites: [], preferences: { theme: "light", notifications: false },
    addresses: [{ id: "home", label: "Home", address: "1-1-277", area: "Naidupeta", city: "Naidupeta", serviceAreaId: "naidupeta-central", lat: 13.90, lng: 79.89 }],
  };
  const cachedRestaurant = {
    id: "cache-kitchen", name: "Cached Kitchen", city: "Naidupeta", address: "Naidupeta",
    cuisines: ["South Indian"], image: "restaurant-placeholder.svg", open: true, archived: false,
    etaMin: 20, etaMax: 30, deliveryFee: 29, platformFee: 15,
    menuIndex: [{ id: "dosa", name: "Dosa", category: "Breakfast", diet: "veg", price: 90, available: true }],
  };
  const seed = {
    "savrivo.customer.seenWelcome": "1",
    "savrivo.customer.session": JSON.stringify(session),
    "savrivo.customer.profile": JSON.stringify(profile),
    "savrivo.customer.homeCache.v1": JSON.stringify({
      "service-naidupetacentral": { savedAt: now, catalog: { "cache-kitchen": cachedRestaurant } },
    }),
  };

  const cached = contextWith(seed, true, () => new Promise(() => {}));
  const started = performance.now();
  vm.runInContext(instrument(original), cached.context, { filename: customerSourcePath, timeout: 3000 });
  const cachedRenderMs = performance.now() - started;
  const cachedMarkup = cached.elements.get("app").innerHTML;
  assert(cachedMarkup.includes("Cached Kitchen"), "cached restaurant was not rendered before network completion");
  assert(!cachedMarkup.includes("Loading restaurants near you"), "legacy full-screen loader is still rendered");
  assert(cached.context.__customer.state.catalogMode === "cached", "cached source is not represented in state");

  const offline = contextWith({
    "savrivo.customer.seenWelcome": "1",
    "savrivo.customer.session": JSON.stringify(session),
    "savrivo.customer.profile": JSON.stringify(profile),
  }, false, async () => { throw new Error("offline"); });
  vm.runInContext(instrument(original), offline.context, { filename: customerSourcePath, timeout: 3000 });
  await offline.context.__bootPromise;
  const offlineMarkup = offline.elements.get("app").innerHTML;
  assert(offlineMarkup.includes("Restaurants could not be loaded"), "offline/no-cache did not reach a retryable error state");
  assert(!offlineMarkup.includes("Finding restaurants for this saved address"), "offline/no-cache remained on an endless skeleton");

  const syncCatalogSource = original.slice(original.indexOf("async function syncCatalog()"), original.indexOf("function normalizeOrders"));
  assert(!syncCatalogSource.includes('DB_ROOT+"/menus"'), "Home critical path still downloads the full menu tree");
  assert(!original.includes("offerAutomaticLocation"), "startup still contains an automatic GPS trigger");
  assert(original.includes("state.catalogRequestSequence"), "latest-address request sequencing is missing");
  const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
  const index = rules.rules.feastly.catalog.restaurants[".indexOn"];
  assert(Array.isArray(index) && index.includes("city"), "Realtime Database city index is missing");

  process.stdout.write(`✓ cached Home rendered before network in ${cachedRenderMs.toFixed(1)} ms\n`);
  process.stdout.write("✓ offline/no-cache resolves to retry state\n");
  process.stdout.write("✓ Home omits the full menu tree and automatic GPS\n");
  process.stdout.write("✓ city query index and latest-request guard are present\n");
}

run().catch(error => {
  process.stderr.write(`Home performance smoke failed: ${error.message}\n`);
  process.exit(1);
});
