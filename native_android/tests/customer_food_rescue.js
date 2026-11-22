#!/usr/bin/env node
"use strict";

// Founder 22 Nov 2026: Food Rescue. An order Scraveit cancels after pickup (the customer's side)
// is offered to customers within 3 km for 15 minutes at half the food price + the normal delivery
// fee, online payment only. Also: cash on delivery turns off for a customer whose cash order was
// cancelled after pickup, and the cancelled order says why.

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
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
  };
}

function makeContext() {
  const storage = new Map();
  const elements = new Map();
  const scheduled = new Map();
  let nextTimer = 1;
  const document = {
    documentElement: makeElement(), visibilityState: "visible", body: makeElement(),
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    querySelector(selector) { return selector === 'meta[name="theme-color"]' ? makeElement() : null; },
    querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {}, createElement() { return makeElement(); },
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
    Image: class Image {}, FEASTLY_FIREBASE: {},
    firebase: createFirebaseCompat({ user: { uid: "c1", email: "c1@example.test", idToken: "t" } }).firebase,
    fetch: async () => { throw new Error("no network in this test"); },
    setTimeout(callback, delay) { const id = nextTimer++; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout(id) { if (id != null) scheduled.delete(id); },
    setInterval: () => nextTimer++, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return nextTimer++; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
    // The phone's bridge: records each request; the test answers it.
    FeastlyNative: {
      getCheckoutConfiguration(requestId, token, payloadJson) { calls.push({ op: "config", requestId, payload: JSON.parse(payloadJson) }); },
      createOrder(requestId, token, payloadJson) { calls.push({ op: "order", requestId, payload: JSON.parse(payloadJson) }); },
      createPaymentIntent(requestId, token, payloadJson) { calls.push({ op: "intent", requestId, payload: JSON.parse(payloadJson) }); },
      // The page calls this with (requestId, url), not a token and JSON.
      openExternalPayment(requestId, url) { calls.push({ op: "external", requestId, payload: { url } }); },
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
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

const original = fs.readFileSync(customerFile, "utf8");
const marker = "bootstrap();";
const index = original.lastIndexOf(marker);
if (index < 0) throw new Error("Customer bootstrap marker was not found");
const instrumented = original.slice(0, index)
  + "render=function(){globalThis.__RENDERS=(globalThis.__RENDERS||0)+1};toast=function(m){globalThis.__TOASTS=(globalThis.__TOASTS||[]).concat(String(m))};"
  + "renderSheet=function(){globalThis.__SHEETS=(globalThis.__SHEETS||0)+1};orderPlacedMoment=function(){};"
  + "globalThis.__R={state,rescueState,normalizeRescue,refreshFoodRescues,foodRescueCard,foodRescueSheet,buyFoodRescue,payFallbackSheet,payFallbackAction,"
  + "normalizeCheckoutConfiguration,paymentMethodEnabled,paymentMethodCopy,paySheet,afterPickupNotice,rescueOrderNotice,screenOrder,finishRescuePlacement};"
  + original.slice(index + marker.length);
const context = makeContext();
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });

const api = context.__R;
const { state } = api;
const last = op => [...context.__calls].reverse().find(c => c.op === op);
const count = op => context.__calls.filter(c => c.op === op).length;
const answer = (op, data) => { context.savrivoNativeResult({ requestId: last(op).requestId, ok: true, data }); return settle(); };
const reject = (op, code, message) => { context.savrivoNativeResult({ requestId: last(op).requestId, ok: false, code, message }); return settle(); };
const toasts = () => context.__TOASTS || [];

const NOW = Date.now();
const offer = (extra = {}) => Object.assign({
  id: "rescue_100000000000001", restaurantName: "Spicy Box", vegOnly: false,
  items: [{ name: "Chicken Biryani", quantity: 1, veg: false }, { name: "Raita", quantity: 1, veg: true }],
  pricePaise: 12000, menuPaise: 24000, expiresAt: NOW + 9 * 60000, distanceKm: 1.2, heldByYou: false,
  deliveryFee: 28, total: 148, etaMin: 15, etaMax: 20,
}, extra);
const onlineConfig = { version: 1, defaultMethod: "upi", onlineGatewayConfigured: true, priceLock: true,
  methods: { cod: { enabled: true, available: true }, upi: { enabled: true, available: true, provider: "cashfree" }, card: { enabled: true, available: true, provider: "cashfree" } } };

(async () => {
  state.online = true;
  state.session = { uid: "c1", idToken: "t" };
  state.route = "home";
  state.checkoutConfig = api.normalizeCheckoutConfiguration(onlineConfig);
  state.profile = Object.assign({}, state.profile, { addresses: [{ id: "a1", label: "Home", address: "12-3 Main Road", lat: 14.4401, lng: 79.9801, door: "1-2", phone: "9876543210" }], selectedAddressId: "a1" });
  state.cart = [{ key: "r1::i1::::", restaurantId: "r1", itemId: "i1", name: "Dosa", price: 60, quantity: 1, addOns: [], addOnIds: [] }];

  // ---- the data from the server ----
  check(api.normalizeRescue({ id: "bad id!" }) === null, "an offer with a bad id is dropped");
  check(api.normalizeRescue(Object.assign(offer(), { total: "x" })) === null, "an offer without a real total is dropped");
  const shaped = api.normalizeRescue(offer());
  check(shaped.food === 120 && shaped.menu === 240 && shaped.fee === 28 && shaped.total === 148, "paise become rupees: ₹120 food (menu ₹240), ₹28 delivery, ₹148 total");

  // ---- Home asks for offers near the selected address ----
  check(api.foodRescueCard() === "", "no card before the server answers");
  await settle();
  const scheduledRefresh = [...context.__scheduled.values()].filter(t => t.delay === 0);
  scheduledRefresh.forEach(t => t.callback());
  await settle();
  check(count("config") === 1 && last("config").payload.foodRescueCheck === true && last("config").payload.addressId === "a1", "home asks the server once: {foodRescueCheck: true, addressId: a1}");
  await answer("config", { foodRescues: [offer()], serverNow: NOW + 30000 });
  check(Math.abs(api.rescueState().offset - 30000) < 2000, "the countdown follows the server clock (phone 30 s behind)");
  const card = api.foodRescueCard();
  check(card.includes("Food Rescue") && card.includes("Chicken Biryani + 1 more") && card.includes("Spicy Box"), "the card names the dish, the extra item and the restaurant");
  check(card.includes("₹120") && card.includes("<s>₹240</s>") && card.includes("₹28") && card.includes("Get it"), "the card shows ₹120 with ₹240 struck out, + ₹28 delivery, and Get it");
  check(/data-rescue-ends="\d+"/.test(card), "the card has a live countdown");
  api.foodRescueCard();
  check(count("config") === 1, "re-drawing home does not ask again within a minute");

  // Another address: the old offers are not shown for it.
  state.profile.addresses.push({ id: "a2", label: "Work", address: "Far away", lat: 14.6, lng: 80.1, door: "9", phone: "9876543210" });
  state.profile.selectedAddressId = "a2";
  check(api.foodRescueCard() === "", "offers checked for Home are not shown for Work");
  state.profile.selectedAddressId = "a1";
  let asking = api.refreshFoodRescues(true); await settle();
  await answer("config", { foodRescues: [offer()], serverNow: NOW }); await asking;

  // ---- the buy sheet ----
  let sheet = api.foodRescueSheet({ type: "foodRescue", rescueId: "rescue_100000000000001" });
  check(sheet.includes("Food at half price") && sheet.includes("₹240") && sheet.includes("₹120") && sheet.includes("₹148"), "the sheet's bill: food at half price ₹120 (₹240 struck), total ₹148");
  check(!/Cash on delivery|data-value="cod"/.test(sheet), "the sheet never offers cash on delivery");
  check(sheet.includes("<span>Pay</span> ₹148") && sheet.includes("kept for you for 3 minutes"), "Pay ₹148, and it says the food is kept for 3 minutes after the tap");

  // ---- Pay: one createOrder call with the rescue id and the shown total ----
  const buying = api.buyFoodRescue("rescue_100000000000001");
  await settle();
  const sent = last("order").payload;
  check(sent.foodRescueId === "rescue_100000000000001" && sent.addressId === "a1" && sent.quotedTotal === 148, "Pay sends createOrder with the rescue id, the address and the ₹148 the customer saw");
  check(["upi", "card"].includes(sent.paymentMethod) && sent.paymentProvider === "cashfree", "the payment is online through Cashfree");
  check(/^rescue_[A-Za-z0-9_-]{8,}$/.test(sent.idempotencyKey) && sent.idempotencyKey.length <= 80, "a fresh request key is sent");
  const order = { id: "200000000000001", customerId: "c1", restaurant: "Spicy Box", status: "Order placed", paymentMethod: sent.paymentMethod, paymentProvider: "cashfree", paymentState: "pending", total: 148,
    items: [{ name: "Chicken Biryani", quantity: 1, price: 120 }], foodRescue: { fromOrderId: "100000000000001", menuPaise: 24000, foodPaise: 12000 } };
  await answer("order", { orderId: order.id, order, deliveryOtp: "4821", recovered: false });
  check(count("intent") === 1 && last("intent").payload.orderId === order.id, "then the payment starts for that order");
  // The phone can't open Cashfree in this test: the payment opens outside the app (older builds).
  await answer("intent", { redirectUrl: "https://payments.example/pay", provider: "cashfree" });
  await answer("external", {});
  await buying;
  check(state.route === "order" && state.routeData.orderId === order.id, "after paying, the order screen opens");
  check(state.cart.length === 1 && state.cart[0].name === "Dosa", "the customer's cart is left as it was");
  check(!api.rescueState().list.some(r => r.id === "rescue_100000000000001"), "the bought offer leaves the home list");
  check(toasts().includes("Food Rescue order placed."), "the customer is told the Food Rescue order is placed");

  // ---- the delivery fee changed between the list and the tap ----
  asking = api.refreshFoodRescues(true); await settle();
  await answer("config", { foodRescues: [offer({ id: "rescue_100000000000002" })], serverNow: Date.now() }); await asking;
  const changed = api.buyFoodRescue("rescue_100000000000002");
  await settle();
  await reject("order", "FAILED_PRECONDITION", "The delivery fee changed. The new total is ₹153.");
  check(toasts().includes("The delivery fee changed. The new total is ₹153."), "a changed fee is shown, nothing is charged");
  check(last("config").payload.foodRescueCheck === true, "and the offers are fetched again for the new total");
  await answer("config", { foodRescues: [offer({ id: "rescue_100000000000002", deliveryFee: 33, total: 153 })], serverNow: Date.now() });
  await changed;
  sheet = api.foodRescueSheet({ type: "foodRescue", rescueId: "rescue_100000000000002" });
  check(sheet.includes("<span>Pay</span> ₹153"), "the sheet now asks for ₹153");

  // ---- someone else took it ----
  const gone = api.buyFoodRescue("rescue_100000000000002");
  await settle();
  await reject("order", "FAILED_PRECONDITION", "Someone else took this food, or its time ran out.");
  await gone;
  check(!api.rescueState().list.some(r => r.id === "rescue_100000000000002"), "an offer someone else took leaves the list");
  check(api.foodRescueSheet({ type: "foodRescue", rescueId: "rescue_100000000000002" }).includes("Someone else took this food"), "and its sheet says so");

  // ---- payment not completed: no cash choice, the hold countdown ----
  const fallback = api.payFallbackSheet({ type: "payFallback", order, checkout: { rescue: true, holdEnds: Date.now() + 120000 }, reason: "You cancelled the payment.", busy: false });
  check(!fallback.includes("Cash on delivery") && !fallback.includes("pay-fallback-cod"), "a Food Rescue payment that didn't finish offers no cash on delivery");
  check(fallback.includes("Kept for you for") && fallback.includes("Try paying again") && !fallback.includes("restaurant"), "it shows how long the food is kept and Try paying again, and no restaurant line");
  const timeUp = api.payFallbackSheet({ type: "payFallback", order, checkout: { rescue: true, holdEnds: Date.now() - 1000 }, reason: "", busy: false });
  check(timeUp.includes("Your 3 minutes are up") && !timeUp.includes("Try paying again"), "after 3 minutes it says the time is up");
  const cartFallback = api.payFallbackSheet({ type: "payFallback", order: { id: "x", paymentMethod: "upi" }, checkout: { deliveryOtp: "1" }, reason: "You cancelled the payment.", busy: false });
  check(cartFallback.includes("pay-fallback-cod") && cartFallback.includes("The restaurant hasn"), "a normal cart order still offers cash on delivery");

  // ---- the buyer's order screen ----
  state.orders = [Object.assign({}, order, { status: "Out for delivery", paymentState: "paid", restaurantPhone: "9000000000" })];
  state.selectedOrderId = order.id; state.routeData = { orderId: order.id };
  const notice = api.rescueOrderNotice(state.orders[0]);
  check(notice.includes("Food Rescue") && notice.includes("You saved") && notice.includes("₹120"), "the order says Food Rescue · You saved ₹120");

  // ---- cash on delivery off for this customer ----
  state.checkoutConfig = api.normalizeCheckoutConfiguration(Object.assign({}, onlineConfig, { codBlocked: true }));
  check(api.paymentMethodEnabled("cod") === false && api.paymentMethodEnabled("upi") === true, "with codBlocked, cash on delivery is off and UPI still works");
  check(api.paymentMethodCopy("cod").startsWith("Cash on delivery is off for your account"), "the cash option says why it is off");
  state.checkoutConfig = api.normalizeCheckoutConfiguration(onlineConfig);
  check(api.paymentMethodEnabled("cod") === true, "without it, cash on delivery is on");

  // ---- the cancelled order says what happened ----
  const cancelled = extra => Object.assign({ id: "300", status: "Cancelled", statusBeforeTerminal: "Out for delivery", cancelledByRole: "ops_admin" }, extra);
  check(api.afterPickupNotice(cancelled({ cancelReason: "Customer cancelled after pickup", paymentMethod: "upi", paymentState: "paid" })).includes("not refunded"), "online + customer's side: not refunded");
  check(api.afterPickupNotice(cancelled({ cancelReason: "Customer not reachable at door", paymentMethod: "cod", paymentState: "cash_due" })).includes("Cash on delivery is now off"), "cash + customer's side: cash on delivery is now off");
  check(api.afterPickupNotice(cancelled({ cancelReason: "Delivery problem", paymentMethod: "upi", paymentState: "paid" })).includes("will be refunded"), "delivery problem, online: money will be refunded");
  check(api.afterPickupNotice(cancelled({ cancelReason: "Delivery problem", paymentMethod: "upi", paymentState: "refunded" })).includes("has been refunded"), "delivery problem, refunded: says it has been refunded");
  check(api.afterPickupNotice(cancelled({ cancelReason: "Delivery problem", paymentMethod: "cod", paymentState: "cash_due" })).includes("need to pay anything"), "delivery problem, cash: nothing to pay");
  check(api.afterPickupNotice(cancelled({ statusBeforeTerminal: "Preparing", cancelReason: "Customer cancelled after pickup", paymentMethod: "upi" })) === "", "a cancel before pickup shows no after-pickup note");
  // Since 22 Nov the customer can cancel after pickup themselves (100% fee): their own cancel gets the note too.
  check(api.afterPickupNotice(cancelled({ cancelledByRole: "customer", cancelReason: "Customer cancelled after pickup", paymentMethod: "upi", paymentState: "paid" })).includes("not refunded"), "a customer's own cancel after pickup: not refunded");
  check(api.afterPickupNotice(cancelled({ cancelledByRole: "staff", cancelReason: "Item unavailable", paymentMethod: "upi" })) === "", "a restaurant's cancel shows no after-pickup note");

  process.stdout.write("customer Food Rescue checks passed\n");
})().catch(error => { console.error(error); process.exit(1); });
