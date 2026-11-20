#!/usr/bin/env node
"use strict";

// Founder 19 Nov 2026: before launch, stores go online but customers who already have the app must not
// be able to order. settings/customer.openingSoon shows "Opening soon" on stores and blocks ordering.
// The server (functions/src/services/openingSoon.ts) refuses every order too.

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
    setTimeout() { return nextTimer++; }, clearTimeout() {},
    setInterval: () => nextTimer++, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return nextTimer++; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
    FeastlyNative: {
      getCheckoutConfiguration(requestId, token, payloadJson) { calls.push({ op: "price", requestId, payload: JSON.parse(payloadJson) }); },
      createOrder(requestId, token, payloadJson) { calls.push({ op: "order", requestId, payload: JSON.parse(payloadJson) }); },
      createCodOrder(requestId, token, payloadJson) { calls.push({ op: "order", requestId, payload: JSON.parse(payloadJson) }); },
      createClusterOrder(requestId, token, payloadJson) { calls.push({ op: "order", requestId, payload: JSON.parse(payloadJson) }); },
    },
  };
  context.window = context;
  context.globalThis = context;
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
  + "render=function(){globalThis.__RENDERS=(globalThis.__RENDERS||0)+1};toast=function(m){globalThis.__TOASTS=(globalThis.__TOASTS||[]).concat(String(m))};"
  + "globalThis.__SOON={state,openingSoon,orderBlockText,restaurantCard,recoCard,screenRestaurant,screenCheckout,addCartItem,submitOrder,submitTogether,OPENING_SOON_TEXT,TEST_STORE_TEXT,isTester,shownToMe,restaurantsAtAddress,normalizeCheckoutConfiguration};"
  + original.slice(index + marker.length);
const context = makeContext();
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });

const api = context.__SOON;
const { state } = api;
const toasts = () => context.__TOASTS || [];
// The cart wakes the order server with a {warmup:true} call; only real orders count.
const orderCalls = () => context.__calls.filter(c => c.op === "order" && !(c.payload && c.payload.warmup)).length;

(async () => {
  state.online = true;
  state.session = { uid: "c1", idToken: "t" };
  state.settings = Object.assign({}, state.settings, { deliveryBaseFee: 20, deliveryPerKm: 5, platformFee: 4.99, taxRate: 0 });
  const store = { id: "r1", name: "Highway Cross", city: "Nellore", open: true, archived: false, lat: 14.44, lng: 79.98, cuisines: ["Biryani"], menu: [{ id: "i1", name: "Biryani", price: 77, available: true }], menuLoaded: true, etaMin: 15, etaMax: 20 };
  state.catalog = { r1: store };
  state.profile = Object.assign({}, state.profile, { addresses: [{ id: "a1", label: "Home", lat: 14.4401, lng: 79.9801, door: "1-2", phone: "9876543210" }], selectedAddressId: "a1" });
  state.route = "restaurant"; state.selectedRestaurantId = "r1";

  // Switch off: the app looks and works exactly as before.
  check(api.openingSoon(store) === false, "with no switch in settings, the app is not in Opening soon mode");
  let card = api.restaurantCard(store);
  check(!card.includes("Opening soon") && /mins/.test(card), "switch off: the store card shows the delivery time");
  api.addCartItem("r1", "i1");
  check(state.cart.length === 1, "switch off: Add puts the dish in the cart");
  state.cart = [];

  // Switch on.
  state.settings.openingSoon = true;
  check(api.openingSoon(store) === true, "settings/customer.openingSoon = true turns Opening soon on");
  card = api.restaurantCard(store);
  check(card.includes('rc2-eta soon">Opening soon') && card.includes("<span>Opening soon</span>"), "store cards show an Opening soon badge and Opening soon instead of the time");
  check(!/\d+\s*mins/.test(card) && !card.includes("is-closed"), "store cards show no delivery time and are not greyed out as closed");
  const closedCard = api.restaurantCard(Object.assign({}, store, { open: false }));
  check(closedCard.includes("Opening soon") && !closedCard.includes("Closed"), "a store outside its hours also says Opening soon, not Closed");
  check(api.recoCard(store).includes("Opening soon"), "recommendation cards say Opening soon");

  const page = api.screenRestaurant();
  check(page.includes('notice opening-soon') && page.includes("Ordering starts the day we launch"), "the store page shows the Opening soon banner");
  check(page.includes('store-chip soon">Opening soon') && !page.includes("Accepting orders"), "the store page chip says Opening soon, not Accepting orders");
  check(page.includes("adds-paused"), "Add buttons on the store page look switched off");

  api.addCartItem("r1", "i1");
  check(state.cart.length === 0, "Add puts nothing in the cart");
  check(toasts().at(-1) === api.OPENING_SOON_TEXT && /opening soon/i.test(api.OPENING_SOON_TEXT), "Add explains: Scraveit is opening soon");

  // A cart saved before the switch: checkout cannot place it.
  state.cart = [{ key: "r1::i1::::", restaurantId: "r1", itemId: "i1", name: "Biryani", price: 77, quantity: 1, addOns: [], addOnIds: [] }];
  state.route = "cart";
  const checkout = api.screenCheckout();
  check(checkout.includes("notice opening-soon"), "checkout shows the Opening soon banner");
  check(/data-action="place-order" disabled><span>Opening soon<\/span>/.test(checkout), "the Place order button is switched off and says Opening soon");
  await api.submitOrder(); await settle();
  check(orderCalls() === 0, "Place order sends nothing to the server");
  check(toasts().at(-1) === api.OPENING_SOON_TEXT, "Place order explains: Scraveit is opening soon");
  await api.submitTogether(); await settle();
  check(orderCalls() === 0 && toasts().at(-1) === api.OPENING_SOON_TEXT, "ordering from several restaurants together is blocked too");

  // Switch off again (launch day): ordering works again.
  state.settings.openingSoon = false;
  check(!api.restaurantCard(store).includes("Opening soon"), "switch off again: Opening soon is gone");
  state.cart = [];
  api.addCartItem("r1", "i1");
  check(state.cart.length === 1, "switch off again: Add works");

  // Test accounts (admin website /test-accounts/): the server marks the account tester:true.
  const testShop = { id: "t1", name: "TIRUMURU BALAJI Restaurant", city: "Nellore", open: true, archived: false, lat: 14.441, lng: 79.981, cuisines: ["Meals"], menu: [{ id: "m1", name: "Meals", price: 10, available: true }], menuLoaded: true, etaMin: 15, etaMax: 20 };
  state.catalog = { r1: store, t1: testShop };
  state.settings.testStoreIds = ["t1"];
  state.settings.openingSoon = true;
  state.cart = [];
  state.checkoutConfig = api.normalizeCheckoutConfiguration({ version: 1, defaultMethod: "cod", methods: { cod: { enabled: true, available: true } } });
  check(api.isTester() === false, "an account the server didn't mark is a real customer");
  check(!api.shownToMe(testShop) && api.shownToMe(store), "real customers don't see test stores");
  check(!api.restaurantsAtAddress().some(r => r.id === "t1"), "test stores are left out of the store list for real customers");

  state.checkoutConfig = api.normalizeCheckoutConfiguration({ version: 1, defaultMethod: "cod", tester: true, methods: { cod: { enabled: true, available: true } } });
  check(api.isTester() === true, "the server's tester:true is kept by the app");
  check(api.shownToMe(testShop) && api.restaurantsAtAddress().some(r => r.id === "t1"), "test accounts see the test stores");
  check(api.openingSoon(testShop) === false && !api.restaurantCard(testShop).includes("Opening soon"), "before launch, test stores are open for test accounts");
  check(api.openingSoon(store) === false && !api.restaurantCard(store).includes("Opening soon"), "before launch, real stores are open for test accounts too");
  api.addCartItem("t1", "m1");
  check(state.cart.length === 1 && state.cart[0].restaurantId === "t1", "a test account can add from a test store before launch");
  state.route = "cart";
  check(!api.screenCheckout().includes("notice opening-soon"), "a test account's checkout at a test store has no Opening soon banner");
  state.cart = [];
  api.addCartItem("r1", "i1");
  check(state.cart.length === 1 && state.cart[0].restaurantId === "r1", "a test account can add from a real store before launch");
  check(api.orderBlockText(store) === "", "nothing blocks a test account at a real store");
  state.cart = [];

  state.settings.openingSoon = false;
  api.addCartItem("r1", "i1");
  check(state.cart.length === 1, "after launch, a test account orders from real stores too");
  state.cart = [];

  state.checkoutConfig = api.normalizeCheckoutConfiguration({ version: 1, defaultMethod: "cod", methods: { cod: { enabled: true, available: true } } });
  api.addCartItem("t1", "m1");
  check(state.cart.length === 0 && toasts().at(-1) === api.TEST_STORE_TEXT, "a real customer who opens a test store by link can't order there");
  api.addCartItem("r1", "i1");
  check(state.cart.length === 1, "after launch, real customers order from real stores");

  process.stdout.write("customer opening-soon checks passed\n");
})().catch(error => { console.error(error); process.exit(1); });
