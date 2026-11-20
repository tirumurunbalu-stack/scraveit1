#!/usr/bin/env node
"use strict";

// Founder 19 Nov 2026: the bill showed delivery ₹20 (the app's own guess), then ₹30 once the server's
// lunch rush fee arrived. The bill must show one value only: the server's final one, never a guess.

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
    FeastlyNative: {
      getCheckoutConfiguration(requestId, token, payloadJson) { calls.push({ op: "price", requestId, payload: JSON.parse(payloadJson) }); },
      createOrder(requestId, token, payloadJson) { calls.push({ op: "order", requestId, payload: JSON.parse(payloadJson) }); },
    },
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
  + "render=function(){globalThis.__RENDERS=(globalThis.__RENDERS||0)+1};toast=function(m){globalThis.__TOASTS=(globalThis.__TOASTS||[]).concat(String(m))};"
  + "globalThis.__BILL={state,priceState,priceBreakdown,billSummaryRow,billSheet,screenCheckout,refreshDynamicPricing,scheduleCheckoutRefresh,pricingBusy,keepCartPriced,dynamicPricingFallback,submitOrder,askParentCard};"
  + original.slice(index + marker.length);
const context = makeContext();
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });

const api = context.__BILL;
const { state } = api;
const lastPrice = () => [...context.__calls].reverse().find(c => c.op === "price");
const priceCalls = () => context.__calls.filter(c => c.op === "price").length;
const answer = data => { context.savrivoNativeResult({ requestId: lastPrice().requestId, ok: true, data }); return settle(); };
const fail = () => { context.savrivoNativeResult({ requestId: lastPrice().requestId, ok: false, code: "FUNCTION_UNAVAILABLE", message: "down" }); return settle(); };
// Fire every waiting timer with this delay (a real timer is gone once it fires).
const fire = delay => { let n = 0; for (const [id, t] of [...context.__scheduled]) if (t.delay === delay) { context.__scheduled.delete(id); t.callback(); n++; } return n; };

// The founder's bill: item 77, delivery 20 at 0 km + lunch rush 10, platform 4.99, GST 10.15, total 122.14.
const lunchBill = (tip = 0) => ({
  priceLock: true,
  feePreview: { deliveryFee: 20, platformFee: 4.99, smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0, riderIncentiveFee: 10, riderIncentiveItems: [{ label: "Lunch rush fee", amount: 10 }], returnTripFee: 0, returnTripKm: 0, roadKm: 0.05, activeOrders: 0 },
  checkoutPreview: { serverAuthoritative: true, subtotal: 77, discount: 0, deliveryFee: 20, platformFee: 4.99, smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0, riderIncentiveFee: 10, tax: 10.15, tip, total: Math.round((122.14 + tip) * 100) / 100, walletBalance: 0, walletMaxForOrder: 0, taxBreakdown: [] },
});
// Amounts on screen other than the item total, the tip buttons and the tip line.
const amounts = html => (html.match(/₹[\d,.]+/g) || []);
const noGuess = (html, allowed) => amounts(html).every(a => allowed.includes(a));

(async () => {
  state.online = true;
  state.session = { uid: "c1", idToken: "t" };
  state.settings = Object.assign({}, state.settings, { deliveryBaseFee: 20, deliveryPerKm: 5, platformFee: 4.99, taxRate: 0, smallOrderFeeEnabled: false, lateNightFeeEnabled: false });
  state.catalog = { r1: { id: "r1", name: "Highway Cross", city: "Nellore", open: true, archived: false, lat: 14.44, lng: 79.98, cuisines: ["Biryani"], menu: [{ id: "i1", name: "Biryani", price: 77, available: true }], etaMin: 15, etaMax: 20 } };
  state.profile = Object.assign({}, state.profile, { addresses: [{ id: "a1", label: "Home", lat: 14.4401, lng: 79.9801, door: "1-2", phone: "9876543210" }], selectedAddressId: "a1" });
  state.cart = [{ key: "r1::i1::::", restaurantId: "r1", itemId: "i1", name: "Biryani", price: 77, quantity: 1, addOns: [], addOnIds: [] }];
  state.tip = 0;

  // Cart opens (what go("cart") does): old price cleared, one request on its way.
  state.route = "cart"; state.placeOpenedAt = Date.now(); state.dynamicPricing = api.dynamicPricingFallback();
  api.refreshDynamicPricing();
  check(priceCalls() === 1, "opening the cart asks the server for the price once");
  check(api.priceState() === "checking", "while the server is answering, the price state is checking");

  let bill = api.priceBreakdown(true);
  check(bill.includes("price-wait"), "the bill shows grey bars while the price is on its way");
  check(noGuess(bill, ["₹77"]), "no guessed delivery fee, GST or total is shown (only the ₹77 item total)");
  check(!bill.includes("Estimated"), "no 'Estimated' lines");
  check(api.billSummaryRow().includes("Checking price…") && noGuess(api.billSummaryRow(), []), "the Total bill row says Checking price… with no amount");
  const sheet0 = api.billSheet();
  check(noGuess(sheet0.replace(/data-value="\d+">₹\d+/g, ""), ["₹77"]), "the Bill summary sheet shows no guessed amount either");

  // 5 seconds later and still no answer: still waiting, never a guess after a time limit.
  state.placeOpenedAt = Date.now() - 5000;
  check(api.priceState() === "checking", "a slow server keeps the bill waiting instead of showing a guess");
  let screen = api.screenCheckout();
  check(screen.includes("Checking price…") && !/pay-cta-total/.test(screen), "Place order waits with Checking price… and no total");
  check(!/₹20\b/.test(screen), "the guessed ₹20 delivery fee is nowhere on the checkout screen");
  check(api.askParentCard() === "" || !/· ₹/.test(api.askParentCard()), "the Ask-to-pay button shows no guessed amount");

  // The server answers with the lunch rush fee: the first and only delivery amount is ₹30.
  await answer(lunchBill());
  check(api.priceState() === "ready", "the server's answer makes the price ready");
  bill = api.priceBreakdown(true);
  check(!bill.includes("price-wait"), "the grey bars are gone");
  check(/Delivery fee[\s\S]*?₹30</.test(bill), "delivery fee shows ₹30 (₹20 + lunch rush ₹10)");
  check(bill.includes("₹4.99") && bill.includes("₹10.15") && bill.includes("₹122.14"), "platform fee, GST and To pay match the server (₹4.99, ₹10.15, ₹122.14)");
  screen = api.screenCheckout();
  check(/pay-cta-total"><strong>₹122\.14/.test(screen), "Place order shows ₹122.14, the same total the server will charge");

  // Customer picks a ₹20 tip in the bill sheet: amounts wait again, the old ones are not left showing.
  state.tip = 20; api.scheduleCheckoutRefresh();
  bill = api.priceBreakdown(true);
  check(api.priceState() === "checking" && bill.includes("price-wait"), "after a tip change the bill waits for the new server price");
  check(noGuess(bill, ["₹77", "₹20"]) && !bill.includes("₹122.14") && !/Delivery fee[\s\S]*?₹30</.test(bill), "no stale total or fee stays on screen while re-pricing");
  check(fire(400) === 1 && priceCalls() === 2, "the re-price is asked once after the customer stops tapping");
  await answer(lunchBill(20));
  bill = api.priceBreakdown(true);
  check(bill.includes("₹142.14") && /Delivery fee[\s\S]*?₹30</.test(bill), "the new total ₹142.14 shows with the same ₹30 delivery fee");

  // Server unreachable: no guess, a clear retry instead.
  state.tip = 0; api.scheduleCheckoutRefresh(); fire(400);
  await fail();
  check(api.priceState() === "failed", "a failed request is recognised");
  bill = api.priceBreakdown(true);
  check(bill.includes("Could not get the price") && bill.includes('data-action="retry-price"') && noGuess(bill, ["₹77"]), "the bill says it could not get the price, offers Try again, and shows no guess");
  screen = api.screenCheckout();
  check(screen.includes("<span>Get price</span>") && !/pay-cta-total/.test(screen), "Place order turns into Get price with no total");
  check(api.billSummaryRow().includes("Tap to try again"), "the Total bill row offers to try again");

  // Tapping Get price asks again and stops at the price: nothing is ordered at an amount they never saw.
  state.placeOpenedAt = Date.now() - 5000;
  const orderCallsBefore = context.__calls.filter(c => c.op === "order").length;
  const tap = api.submitOrder();
  await settle();
  check(priceCalls() === 4, "Get price asks the server again");
  await answer(lunchBill());
  await tap;
  check(context.__calls.filter(c => c.op === "order").length === orderCallsBefore, "no order is placed on that tap");
  check((context.__TOASTS || []).some(t => t.includes("Total ₹122.14. Tap Place order to confirm.")), "the customer is told the final total first");
  check(/pay-cta-total"><strong>₹122\.14/.test(api.screenCheckout()), "Place order now shows ₹122.14");

  // Safety net: a cart change that didn't ask for a price gets one by itself (at most twice per cart).
  state.cart[0].quantity = 2;
  check(api.priceState() === "checking" && !api.pricingBusy(), "a changed cart with no request on its way is detected");
  const before = priceCalls();
  api.keepCartPriced(); fire(0); fire(400);
  check(priceCalls() === before + 1, "the checkout asks for the missing price by itself");

  process.stdout.write("customer one-bill checks passed\n");
})().catch(error => { console.error(error); process.exit(1); });
