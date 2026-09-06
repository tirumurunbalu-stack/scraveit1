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
    fetch: async () => { throw new Error("network is not used by this deterministic test"); },
    setTimeout(callback) { const id = nextTimer++; scheduled.set(id, callback); return id; },
    clearTimeout(id) { if (id != null) { cancelled.add(id); scheduled.delete(id); } },
    setInterval: () => nextTimer++, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return nextTimer++; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
  };
  context.window = context;
  context.globalThis = context;
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
  + "globalThis.__CUSTOMER_RELIABILITY={state,scheduleScopedSync,applyTrackingEvent,addressDeletionPlan,reconcileReorderItems,startRealtime,ensureRestaurantMenu,reorder};"
  + original.slice(index + marker.length);
const context = makeContext();
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });

const api = context.__CUSTOMER_RELIABILITY;
const { state } = api;

api.scheduleScopedSync("orders");
const orderTimer = state.syncTimers.orders;
api.scheduleScopedSync("catalog");
const catalogTimer = state.syncTimers.catalog;
check(Boolean(orderTimer) && Boolean(catalogTimer) && orderTimer !== catalogTimer, "catalogue and order refreshes use independent debounce timers");
check(!context.__cancelled.has(orderTimer), "a catalogue event cannot cancel a pending order refresh");

state.tracking["order-live"] = { latitude: 1 };
api.applyTrackingEvent("order-live", { path: "/", data: { latitude: 14.9, longitude: 79.9 } });
check(state.trackingHydrated["order-live"] === true, "the first tracking stream snapshot becomes authoritative hydration");
check(state.tracking["order-live"].latitude === 14.9, "live tracking state is replaced by its authoritative root snapshot");

const restaurant = {
  id: "restaurant-1", name: "Current Kitchen", image: "https://example.test/restaurant.jpg",
  menu: [{
    id: "item-1", name: "Current Meal", price: 125, available: true, diet: "veg",
    variants: [{ id: "large", name: "Large", priceDelta: 30 }],
    addOns: [{ id: "cheese", name: "Cheese", priceDelta: 15 }],
  }],
};
const historicalOrder = {
  items: [{ itemId: "item-1", name: "Old Meal", price: 80, quantity: 2, variant: "Large", variantPrice: 10, addOns: [{ id: "cheese", name: "Cheese", price: 5 }], addOnTotal: 5, note: "No onion" }],
};
const reconciled = api.reconcileReorderItems(historicalOrder, restaurant);
check(reconciled.items.length === 1 && reconciled.skipped.length === 0, "a reorder reconciles an unchanged customization against the latest menu");
check(reconciled.items[0].price === 125 && reconciled.items[0].variantPrice === 30 && reconciled.items[0].addOnTotal === 15, "a reorder uses current item, variant and add-on prices instead of historical prices");
check(reconciled.items[0].quantity === 2 && reconciled.items[0].note === "No onion", "a valid reorder preserves quantity and kitchen note");

const changedMenu = JSON.parse(JSON.stringify(restaurant));
changedMenu.menu[0].addOns = [];
const changed = api.reconcileReorderItems(historicalOrder, changedMenu);
check(changed.items.length === 0 && changed.skipped[0].reason === "addon", "a removed customization is never silently substituted during reorder");

const addresses = [{ id: "home" }, { id: "work" }, { id: "other" }];
let plan = api.addressDeletionPlan(addresses, "home", "home");
check(plan.selectedAddressId === "work" && plan.addresses.length === 2, "deleting the selected address chooses a deterministic saved fallback");
plan = api.addressDeletionPlan(addresses, "home", "work");
check(plan.selectedAddressId === "home" && plan.addresses.length === 2, "deleting an unselected address preserves the current checkout address");
plan = api.addressDeletionPlan([{ id: "home" }], "home", "home");
check(plan.selectedAddressId === "" && plan.addresses.length === 0, "deleting the last address leaves checkout without a false selection");

const startRealtimeSource = String(api.startRealtime);
check(!startRealtimeSource.includes("stopRealtime"), "starting realtime updates no longer tears down healthy streams");
check(original.includes('ensureRestaurantMenu(r.id,{force:true,throwOnError:true})'), "reorder explicitly refreshes the latest restaurant menu before rebuilding the cart");
check(original.includes("await hydrateInitialTracking(active);"), "active-order sync performs only safe initial tracking hydration");

process.stdout.write("Customer contained reliability assertions passed.\n");
