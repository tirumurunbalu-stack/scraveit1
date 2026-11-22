#!/usr/bin/env node
"use strict";

// Admin app: cancelling after the delivery partner has the food (founder 22 Nov 2026).
// The server accepts only three reasons then (functions/src/domain/afterPickup.ts).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { createFirebaseCompat } = require("./support/firebase_compat_stub");

const sourcePath = path.join(__dirname, "..", "admin", "src", "main", "assets", "premium.js");
const sessionKey = "savrivo.control.session";
const marker = "\n  if(!window.__SAVRIVO_ADMIN_TEST__)bootstrap();\n})();";
const source = fs.readFileSync(sourcePath, "utf8");
assert(source.includes(marker), "Admin test seam could not locate bootstrap marker");
const instrumented = source.replace(marker, `
  globalThis.__CANCEL_TEST__={state,canCancelOrder,cancelSheet,cancelOrder,afterPickupNoteMarkup,AFTER_PICKUP_REASONS,CANCEL_REASONS};
})();`);

function element() {
  return {
    innerHTML: "",
    value: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
}

class TestForm {
  constructor(values, dataset) {
    this.values = Object.assign({}, values);
    this.dataset = Object.assign({}, dataset);
    this.button = { disabled: false, innerHTML: "", textContent: "" };
  }
  querySelector(selector) {
    return selector.includes("button") ? this.button : null;
  }
}

class TestFormData {
  constructor(form) { this.form = form; }
  get(key) {
    return Object.prototype.hasOwnProperty.call(this.form.values, key)
      ? this.form.values[key]
      : null;
  }
}

function createRuntime(storage) {
  const nodes = new Map([
    ["app", element()],
    ["toast-region", element()],
    ["sheet-region", element()],
  ]);
  const calls = { dashboard: 0, status: [] };
  const localStorage = {
    getItem(key) { return storage.has(String(key)) ? storage.get(String(key)) : null; },
    setItem(key, value) { storage.set(String(key), String(value)); },
    removeItem(key) { storage.delete(String(key)); },
  };
  const document = {
    visibilityState: "visible",
    documentElement: { dataset: {} },
    getElementById(id) { return nodes.get(String(id)) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const context = {
    console,
    crypto: webcrypto,
    TextEncoder,
    AbortController,
    URL,
    Blob,
    Intl,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    Promise,
    RegExp,
    Error,
    HTMLFormElement: TestForm,
    FormData: TestFormData,
    document,
    localStorage,
    navigator: { onLine: true },
    FEASTLY_FIREBASE: {
      databaseUrl: "https://example.invalid",
      storageBucket: "example.invalid",
      apiKey: "test-api-key",
    },
    Image: class {},
    firebase: createFirebaseCompat({ user: { uid: "admin-owner", email: "owner@example.test", idToken: "a".repeat(64) } }).firebase,
    EventSource: class {},
    scrollY: 0,
    scrollTo() {},
    requestAnimationFrame(callback) { callback(); },
    cancelAnimationFrame() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    addEventListener() {},
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    fetch: async () => ({ ok: true, status: 200, text: async () => "null" }),
  };
  context.window = context;
  context.globalThis = context;
  context.SavrivoCloudNative = {
    getAdminDashboard(requestId) {
      calls.dashboard += 1;
      context.SavrivoNativeCallbacks.resolve(requestId, true, dashboardProjection());
    },
    updateOrderStatus(requestId, idToken, payloadJson) {
      calls.status.push(JSON.parse(payloadJson));
      context.SavrivoNativeCallbacks.resolve(requestId, true, { ok: true });
    },
  };
  vm.createContext(context);
  vm.runInContext(instrumented, context, { filename: sourcePath });
  return { context, api: context.__CANCEL_TEST__, calls, nodes };
}

function ownerSession() {
  return {
    uid: "admin-owner",
    email: "owner@example.test",
    idToken: "a".repeat(64),
    refreshToken: "b".repeat(64),
    expiresAt: Date.now() + 3_600_000,
    name: "Owner",
  };
}

const FLOW = ["Order placed", "Accepted", "Preparing", "Ready for pickup", "Assigned", "Handed to rider", "Out for delivery", "Near you", "Arrived", "Delivered"];
const AFTER = ["Handed to rider", "Out for delivery", "Near you", "Arrived"];

function orderAt(status, extra) {
  return Object.assign({ id: "order-" + status.replace(/\W+/g, "-").toLowerCase(), userId: "cust-1", status, paymentMethod: "upi", paymentState: "paid" }, extra || {});
}

(async () => {
  const runtime = createRuntime(new Map([[sessionKey, JSON.stringify(ownerSession())]]));
  const { api, calls } = runtime;
  api.state.role = "owner";
  api.state.session = ownerSession();

  // Who may cancel, and up to when.
  for (const status of FLOW) {
    const expected = status !== "Delivered";
    assert.strictEqual(api.canCancelOrder(orderAt(status)), expected, `owner cancel at ${status}`);
  }
  assert.strictEqual(api.canCancelOrder(orderAt("Cancelled")), false, "cancelled orders stay cancelled");
  api.state.role = "staff";
  assert.strictEqual(api.canCancelOrder(orderAt("Out for delivery")), false, "staff accounts can't cancel after pickup");
  api.state.role = "owner";

  // Before pickup: the usual five reasons, no money note.
  const before = orderAt("Assigned");
  api.state.orders = [before];
  const beforeSheet = api.cancelSheet({ type: "cancel", orderId: before.id });
  for (const reason of api.CANCEL_REASONS) assert(beforeSheet.includes(">" + reason + "<"), `before pickup lists ${reason}`);
  for (const reason of api.AFTER_PICKUP_REASONS) assert(!beforeSheet.includes(reason), `before pickup hides ${reason}`);
  assert(!beforeSheet.includes("cancel-note"), "no after-pickup note before pickup");

  // After pickup: only the three reasons, with what happens to the money.
  for (const status of AFTER) {
    const o = orderAt(status);
    api.state.orders = [o];
    const sheet = api.cancelSheet({ type: "cancel", orderId: o.id });
    const options = sheet.match(/<option>[^<]*<\/option>/g) || [];
    assert.deepStrictEqual(options, [...api.AFTER_PICKUP_REASONS].map((r) => "<option>" + r + "</option>"), `${status} shows only the three reasons`);
    assert(sheet.includes("cancel-note") && sheet.includes("No refund"), `${status} explains the first reason`);
  }
  const online = orderAt("Out for delivery");
  const cash = orderAt("Out for delivery", { paymentMethod: "cod", paymentState: "pending" });
  assert(api.afterPickupNoteMarkup(online, "Customer not reachable at door").includes("No refund"));
  assert(api.afterPickupNoteMarkup(online, "Customer not reachable at door").includes("Food Rescue"));
  assert(api.afterPickupNoteMarkup(cash, "Customer cancelled after pickup").includes("Cash on delivery turns off"));
  assert(api.afterPickupNoteMarkup(online, "Delivery problem").includes("Full refund"));
  assert(api.afterPickupNoteMarkup(cash, "Delivery problem").includes("The customer pays nothing"));
  assert(api.afterPickupNoteMarkup(cash, "Delivery problem").includes("No Food Rescue"));

  // Picked up while the sheet was open with an old reason: re-ask, never send a reason the server refuses.
  api.state.orders = [online];
  await api.cancelOrder(online.id, "Item unavailable");
  assert.strictEqual(calls.status.length, 0, "an old reason after pickup must not reach the server");
  assert.strictEqual(api.state.sheet && api.state.sheet.afterPickup, true, "the sheet reopens with the after-pickup reasons");

  // A proper after-pickup reason goes through.
  await api.cancelOrder(online.id, "Customer not reachable at door");
  assert.strictEqual(calls.status.length, 1, "after-pickup cancel reaches the server once");
  assert.strictEqual(calls.status[0].toStatus, "Cancelled");
  assert.strictEqual(calls.status[0].reason, "Customer not reachable at door");
  assert.strictEqual(calls.status[0].orderId, online.id);

  // Delivered orders can't be cancelled.
  const done = orderAt("Delivered");
  api.state.orders = [done];
  await api.cancelOrder(done.id, "Delivery problem");
  assert.strictEqual(calls.status.length, 1, "delivered orders never reach the server");

  process.stdout.write("admin after-pickup cancel checks passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
