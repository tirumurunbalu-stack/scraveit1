#!/usr/bin/env node
"use strict";

// The store page and the cart say "delivery partners are busy" before Place order is tapped.
// The answer comes from getCheckoutConfiguration ({restaurantId, deliveryPartnerCheck:true}).

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
  const storage = new Map();
  const elements = new Map();
  const scheduled = new Map();
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
  const calls = [];
  const context = {
    console, document, localStorage, navigator: { onLine: true }, crypto: webcrypto,
    TextEncoder, AbortController, HTMLFormElement, FormData: global.FormData,
    Image: class Image {}, FEASTLY_FIREBASE: {}, firebase: createFirebaseCompat().firebase,
    fetch: async () => { throw new Error("no network in this test"); },
    setTimeout(callback, delay) { const id = nextTimer++; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout(id) { if (id != null) scheduled.delete(id); },
    setInterval: () => nextTimer++, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return nextTimer++; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
    // The phone's bridge: records each request; the test answers it.
    FeastlyNative: { getCheckoutConfiguration(requestId, token, payloadJson) { calls.push({ requestId, payload: JSON.parse(payloadJson) }); } },
  };
  context.window = context;
  context.globalThis = context;
  context.__scheduled = scheduled;
  context.__calls = calls;
  return vm.createContext(context);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`✓ ${message}\n`);
}
const settle = () => new Promise(resolve => setImmediate(resolve));

const original = fs.readFileSync(customerFile, "utf8");
const marker = "bootstrap();";
const index = original.lastIndexOf(marker);
if (index < 0) throw new Error("Customer bootstrap marker was not found");
const instrumented = original.slice(0, index)
  + "render=function(){globalThis.__RENDERS=(globalThis.__RENDERS||0)+1};"
  + "globalThis.__PARTNERS={state,partnerChecks,partnersBusy,partnerBusyBanner,partnersBusyText,notePartnersBusy,checkPartners,partnerCheckStoreId,ensurePartnerCheck,restaurantInfoMarkup};"
  + original.slice(index + marker.length);
const context = makeContext();
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });

const api = context.__PARTNERS;
const { state } = api;
const BUSY = "All delivery partners near Highway Cross are busy right now. Please try again in a few minutes.";
const answer = data => { const call = context.__calls[context.__calls.length - 1]; context.savrivoNativeResult({ requestId: call.requestId, ok: true, data }); return settle(); };
const fail = () => { const call = context.__calls[context.__calls.length - 1]; context.savrivoNativeResult({ requestId: call.requestId, ok: false, code: "FUNCTION_UNAVAILABLE", message: "down" }); return settle(); };
const busyTimers = () => [...context.__scheduled.values()].filter(t => t.delay === 20000);
// A real timer is gone once it fires; do the same here.
const fireBusyTimer = () => { for (const [id, t] of context.__scheduled) if (t.delay === 20000) { context.__scheduled.delete(id); t.callback(); return; } throw new Error("no 20-second re-check is waiting"); };
const store = { id: "r1", name: "Highway Cross", city: "Nellore", open: true, archived: false, cuisines: ["Biryani"], menu: [], etaMin: 15, etaMax: 20 };
const chip = () => api.restaurantInfoMarkup(state.catalog.r1, { value: 0, label: "" }, false);

(async () => {
  state.online = true;
  state.catalog = { r1: store, r2: Object.assign({}, store, { id: "r2", name: "Closed Store", open: false }) };
  state.cart = [];

  // Not signed in: nothing is asked.
  state.session = null; state.route = "restaurant"; state.selectedRestaurantId = "r1";
  api.ensurePartnerCheck(); await settle();
  check(context.__calls.length === 0, "nothing is asked before the customer is signed in");

  // Signed in, store page opens: one small request.
  state.session = { uid: "c1", idToken: "t" };
  state.route = "home"; api.ensurePartnerCheck();
  state.route = "restaurant"; api.ensurePartnerCheck(); await settle();
  check(context.__calls.length === 1, "opening a store page asks the server once");
  check(JSON.stringify(context.__calls[0].payload) === JSON.stringify({ restaurantId: "r1", deliveryPartnerCheck: true }), "the request carries only the store and the check flag");
  check(!api.partnersBusy("r1") && api.partnerBusyBanner(store) === "", "nothing is shown while the answer is on its way");

  await answer({ deliveryPartners: { busy: true, message: BUSY } });
  check(api.partnersBusy("r1"), "a busy answer is remembered for the store");
  check(api.partnerBusyBanner(store).includes("Delivery partners are busy") && api.partnerBusyBanner(store).includes("Highway Cross are busy right now"), "the store page shows the busy banner with the server's words");
  // Founder 10 Nov 2026 ("Remove that no need"): the banner alone says busy, so the chip row just drops "Accepting orders".
  check(!chip().includes("Accepting orders") && !chip().includes("Currently closed"), "while delivery partners are busy the store stops saying accepting orders (the banner says busy)");
  check(context.__RENDERS >= 1, "the page redraws when the answer arrives");
  check(busyTimers().length === 1, "while busy shows, one re-check is set for 20 seconds later");

  // Redrawing the same page asks nothing more.
  api.ensurePartnerCheck(); api.ensurePartnerCheck(); await settle();
  check(context.__calls.length === 1, "redrawing the same page does not ask again");

  // 20 seconds later (the re-check only asks once the last answer is 18 s old): a delivery partner is free.
  api.partnerChecks.r1.at -= 19000;
  fireBusyTimer(); await settle();
  check(context.__calls.length === 2, "the 20-second re-check asks again");
  await answer({ deliveryPartners: { busy: false, message: "" } });
  check(!api.partnersBusy("r1") && api.partnerBusyBanner(store) === "", "the banner clears by itself when a delivery partner is free");
  check(chip().includes("Accepting orders"), "the store chip goes back to accepting orders");
  check(busyTimers().length === 0, "re-checks stop once the store is not busy");

  // Cart opens: asks again when the last answer is older than 15 seconds.
  state.cart = [{ restaurantId: "r1", itemId: "i1", name: "Biryani", price: 100, quantity: 1 }];
  api.partnerChecks.r1.at -= 16000;
  state.route = "cart"; api.ensurePartnerCheck(); await settle();
  check(context.__calls.length === 3, "opening the cart asks again");
  await answer({ deliveryPartners: { busy: true, message: BUSY } });
  check(api.partnerBusyBanner(store).includes("Delivery partners are busy"), "the cart shows the busy banner");

  // A failed request keeps the last answer for a while, then stops counting.
  api.partnerChecks.r1.at -= 19000;
  fireBusyTimer(); await settle();
  await fail();
  check(api.partnersBusy("r1"), "one failed re-check does not flip the banner");
  api.partnerChecks.r1.at -= 90000;
  check(!api.partnersBusy("r1") && api.partnerBusyBanner(store) === "", "a busy answer nobody could refresh stops counting after 90 seconds");

  // An older server replies with the plain settings: never busy.
  state.route = "home"; api.ensurePartnerCheck();
  api.partnerChecks.r1 = { busy: false, message: "", at: 0, pending: false };
  state.route = "restaurant"; api.ensurePartnerCheck(); await settle();
  await answer({ cod: true, upi: true });
  check(!api.partnersBusy("r1"), "a server without the check never shows busy");

  // First request fails outright: never busy.
  state.route = "home"; api.ensurePartnerCheck();
  api.partnerChecks.r1 = { busy: false, message: "", at: 0, pending: false };
  state.route = "restaurant"; api.ensurePartnerCheck(); await settle();
  await fail();
  check(!api.partnersBusy("r1"), "a failed request never shows busy");

  // Closed store and offline: nothing is asked.
  const before = context.__calls.length;
  state.route = "home"; api.ensurePartnerCheck();
  state.selectedRestaurantId = "r2"; state.route = "restaurant"; api.ensurePartnerCheck(); await settle();
  check(context.__calls.length === before && api.partnerCheckStoreId() === "", "a closed store is not checked");
  state.route = "home"; api.ensurePartnerCheck();
  api.partnerChecks.r1 = { busy: false, message: "", at: 0, pending: false };
  state.online = false; state.selectedRestaurantId = "r1"; state.route = "restaurant"; api.ensurePartnerCheck(); await settle();
  check(context.__calls.length === before, "nothing is asked while the phone is offline");
  state.online = true;

  // Place order refused by the server for this reason: its own words, nothing wrapped around them.
  check(api.partnersBusyText({ message: "FAILED_PRECONDITION", userMessage: BUSY }) === BUSY, "the server's busy refusal is recognised");
  check(api.partnersBusyText({ message: "FAILED_PRECONDITION", userMessage: "This dish is no longer available." }) === "", "other refusals are not mistaken for it");
  api.notePartnersBusy("r1", BUSY);
  check(api.partnersBusy("r1") && api.partnerBusyBanner(store).includes("Highway Cross are busy right now"), "after a refusal the banner shows on the cart");

  process.stdout.write("customer partner-busy checks passed\n");
})().catch(error => { console.error(error); process.exit(1); });
