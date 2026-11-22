#!/usr/bin/env node
"use strict";

// Founder 22 Nov 2026: the customer cancels their own order from the order page. Free until the
// restaurant accepts; after that the food is being prepared, so the sheet shows the 100%
// cancellation fee and the customer confirms it. The server decides by the order's status when the
// tap lands (cancelUnpaidOrder, reason "self"), and asks for the fee first if the restaurant
// accepted while the sheet was open.

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
    setTimeout() { return nextTimer++; }, clearTimeout() {},
    setInterval: () => nextTimer++, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return nextTimer++; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
    FeastlyNative: {
      cancelUnpaidOrder(requestId, token, payloadJson) { calls.push({ op: "cancel", requestId, payload: JSON.parse(payloadJson) }); },
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
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

const original = fs.readFileSync(customerFile, "utf8");
const marker = "bootstrap();";
const index = original.lastIndexOf(marker);
if (index < 0) throw new Error("Customer bootstrap marker was not found");
const instrumented = original.slice(0, index)
  + "render=function(){globalThis.__RENDERS=(globalThis.__RENDERS||0)+1};toast=function(m,t){globalThis.__TOASTS=(globalThis.__TOASTS||[]).concat(String(t||'')+':'+String(m))};"
  + "renderSheet=function(){globalThis.__SHEETS=(globalThis.__SHEETS||0)+1};"
  + "globalThis.__C={state,setSheet,cancelSheet,confirmSelfCancel,canSelfCancel,cancelFeeApplies,cancelFeeNotice,afterPickupNotice,screenOrder};"
  + original.slice(index + marker.length);
const context = makeContext();
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });

const api = context.__C;
const { state } = api;
const last = op => [...context.__calls].reverse().find(c => c.op === op);
const count = op => context.__calls.filter(c => c.op === op).length;
const answer = (op, data) => { context.savrivoNativeResult({ requestId: last(op).requestId, ok: true, data }); return settle(); };
const reject = (op, code, message) => { context.savrivoNativeResult({ requestId: last(op).requestId, ok: false, code, message }); return settle(); };
const toasts = () => context.__TOASTS || [];

const order = (extra = {}) => Object.assign({
  id: "100000000000123", customerId: "c1", restaurantId: "r1", restaurant: "Spice Route Kitchen", status: "Preparing",
  items: [{ itemId: "d1", name: "Chicken Dum Biryani", quantity: 1, price: 219, diet: "nonveg", addOns: [], variant: "" }],
  pricing: { subtotal: 408, discount: 0, deliveryFee: 35, platformFee: 5, tax: 0, tip: 0 }, total: 448,
  paymentMethod: "upi", paymentState: "paid", address: { id: "a1", label: "Home", address: "12 Main Road" },
  createdAt: Date.now() - 600000, updatedAt: Date.now() - 60000, statusHistory: {},
}, extra);
// The page escapes text (won't → won&#39;t); read it as the customer sees it.
const shown = html => String(html).replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const sheetFor = o => { state.orders = [o]; return shown(api.cancelSheet({ type: "cancel", orderId: o.id })); };

(async () => {
  state.online = true;
  state.session = { uid: "c1", idToken: "t" };

  // ---- who sees Cancel order ----
  for (const status of ["Order placed", "Accepted", "Preparing", "Ready for pickup", "Assigned", "Handed to rider", "Out for delivery", "Near you", "Arrived"]) {
    if (!api.canSelfCancel(order({ status }))) throw new Error("live order should be cancellable: " + status);
  }
  check(true, "every live order, from Order placed to Arrived, can be cancelled by the customer");
  check(!api.canSelfCancel(order({ status: "Delivered" })) && !api.canSelfCancel(order({ status: "Cancelled" })), "delivered and cancelled orders can't");
  check(!api.canSelfCancel(order({ customerId: "host" })), "a squad guest can't cancel the host's order");
  check(!api.cancelFeeApplies(order({ status: "Order placed" })) && api.cancelFeeApplies(order({ status: "Accepted" })), "the fee starts when the restaurant accepts");

  // ---- the sheet ----
  const fee = sheetFor(order({ status: "Preparing" }));
  check(fee.includes("Your food is already being prepared.") && fee.includes("A 100% cancellation fee applies"), "after Accept: food is being prepared, 100% fee applies");
  check(fee.includes("Cancellation fee (100%)") && fee.includes("₹448") && fee.includes("You won't get a refund for this order."), "online: the fee is the whole ₹448 and there's no refund");
  check(fee.includes("Confirm cancellation") && fee.includes("Keep my order"), "Confirm cancellation and Keep my order buttons");
  const cash = sheetFor(order({ status: "Accepted", paymentMethod: "cod", paymentState: "pending" }));
  check(cash.includes("cash on delivery will be turned off for your account") && !cash.includes("Cancellation fee (100%)"), "cash: says cash on delivery goes off, shows no charge line");
  check(sheetFor(order({ status: "Out for delivery" })).includes("The delivery partner already has your food."), "after pickup: the partner already has the food");
  const free = sheetFor(order({ status: "Order placed" }));
  check(free.includes("The restaurant hasn't accepted your order yet.") && free.includes("Cancelling is free") && !free.includes("100%"), "before Accept: cancelling is free");
  check(free.includes("Your full payment will be refunded") && free.includes("₹448"), "a paid order shows the full refund");
  check(sheetFor(order({ status: "Order placed", paymentMethod: "cod", paymentState: "pending" })).includes("You won't pay anything."), "a free cash cancel costs nothing");
  check(sheetFor(order({ status: "Delivered" })).includes("This order is already delivered."), "a delivered order explains it can't be cancelled");

  // ---- the order page ----
  state.route = "order"; state.selectedOrderId = "100000000000123";
  state.orders = [order({ status: "Preparing" })];
  let page = "";
  try { page = api.screenOrder(); } catch (_) { page = ""; }
  if (page) {
    check(page.includes('data-action="cancel-order"') && page.includes(">Cancel order<") && !page.includes("Request cancellation"), "the order page has Cancel order, not the old request");
  }

  // ---- confirming with the fee ----
  state.orders = [order({ status: "Preparing" })];
  api.setSheet({ type: "cancel", orderId: "100000000000123" });
  const busy = api.confirmSelfCancel("100000000000123");
  await settle();
  check(count("cancel") === 1 && last("cancel").payload.reason === "self" && last("cancel").payload.acceptFee === true && last("cancel").payload.orderId === "100000000000123", "sends {reason: self, acceptFee: true} to the server");
  check(state.sheet && state.sheet.busy === true, "the sheet waits while the server answers");
  await answer("cancel", { orderId: "100000000000123", status: "Cancelled", cancellationFee: { percent: 100, amountPaise: 44800, acceptedAt: Date.now() } });
  await busy;
  check(state.orders[0].status === "Cancelled" && state.orders[0].cancellationFee.percent === 100 && state.orders[0].cancelledByRole === "customer", "the order shows as cancelled with the fee");
  check(state.sheet === null && toasts().includes("success:Order cancelled"), "the sheet closes and says Order cancelled");
  check(shown(api.cancelFeeNotice(state.orders[0])).includes("not refunded"), "the cancelled order explains there's no refund");
  check(api.cancelFeeNotice(order({ status: "Cancelled", statusBeforeTerminal: "Preparing", cancelledByRole: "customer", paymentMethod: "cod", cancellationFee: { percent: 100 } })).includes("Cash on delivery is now off"), "a cash order explains cash on delivery is off");
  check(api.cancelFeeNotice(order({ status: "Cancelled", statusBeforeTerminal: "Order placed", cancelledByRole: "customer" })) === "", "a free cancel shows no fee note");
  check(api.afterPickupNotice(order({ status: "Cancelled", statusBeforeTerminal: "Out for delivery", cancelledByRole: "customer", cancelReason: "Customer cancelled after pickup", cancellationFee: { percent: 100 } })).includes("not refunded"), "a cancel after pickup keeps the after-pickup note");

  // ---- the restaurant accepted while the sheet was open ----
  state.orders = [order({ status: "Order placed" })];
  api.setSheet({ type: "cancel", orderId: "100000000000123" });
  const racing = api.confirmSelfCancel("100000000000123");
  await settle();
  check(last("cancel").payload.acceptFee === false, "a free cancel doesn't accept any fee");
  await answer("cancel", { orderId: "100000000000123", status: "Accepted", feeRequired: true });
  await racing;
  check(state.sheet && state.sheet.feeNow === true && state.sheet.busy === false && state.orders[0].status === "Order placed", "nothing is cancelled: the sheet stays open");
  check(toasts().some(t => t.startsWith("warning:") && t.includes("100% cancellation fee now applies")), "the customer is told the fee applies now");
  check(shown(api.cancelSheet(state.sheet)).includes("A 100% cancellation fee applies"), "the sheet now shows the fee");
  const second = api.confirmSelfCancel("100000000000123");
  await settle();
  check(last("cancel").payload.acceptFee === true, "confirming again accepts the fee");
  await reject("cancel", "FAILED_PRECONDITION", "This order is already delivered.");
  await second;
  check(state.sheet && state.sheet.busy === false && toasts().some(t => t === "danger:This order is already delivered."), "a server refusal shows its reason and the sheet can be used again");

  process.stdout.write("customer self-cancel checks passed\n");
})().catch((error) => { console.error(error); process.exit(1); });
