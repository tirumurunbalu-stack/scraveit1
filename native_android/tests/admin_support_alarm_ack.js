#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const adminSource = fs.readFileSync(
  path.join(__dirname, "..", "admin", "src", "main", "assets", "premium.js"),
  "utf8"
);

function createElement() {
  return {
    innerHTML: "",
    dataset: {},
    style: {},
    classList: { contains: () => false, toggle: () => {} },
    addEventListener: () => {},
    setAttribute: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
}

function loadAdmin() {
  const nativeCalls = [];
  const patches = [];
  const storage = new Map();
  const document = {
    documentElement: { dataset: {} },
    visibilityState: "visible",
    getElementById: () => createElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    scrollY: 0,
    scrollTo: () => {},
    requestAnimationFrame: (callback) => callback(),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    navigator: { onLine: true },
    document,
    HTMLFormElement: function HTMLFormElement() {},
    FormData: function FormData() {},
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    fetch: async (url, options = {}) => {
      if (options.method === "PATCH") {
        patches.push({ url: String(url), body: JSON.parse(options.body || "{}") });
      }
      return { ok: true, text: async () => "{}" };
    },
    window: {
      __SAVRIVO_ADMIN_TEST__: true,
      FEASTLY_FIREBASE: { databaseUrl: "https://example.test" },
      addEventListener: () => {},
      FeastlyAdminNative: {
        startSupportAlarm: (title, body, id) => nativeCalls.push({ type: "start", title, body, id }),
        stopSupportAlarm: (id) => nativeCalls.push({ type: "stop", id }),
      },
    },
  };
  context.FeastlyAdminNative = context.window.FeastlyAdminNative;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(adminSource, context, { filename: "premium.js" });
  return { api: context.window.__SAVRIVO_ADMIN_SUPPORT_TEST__, nativeCalls, patches };
}

function ticket(overrides = {}) {
  return Object.assign({
    id: "ticket-a",
    uid: "customer-a",
    customerName: "Customer A",
    email: "customer@example.test",
    orderId: "",
    topic: "Support",
    message: "I need help with my order",
    status: "open",
    createdAt: 1000,
    updatedAt: 1000,
  }, overrides);
}

(async function run() {
  const first = loadAdmin();
  const supportTicket = ticket();
  first.api.state.session = { uid: "admin", email: "admin@example.test", idToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 600000 };
  first.api.state.support = { "customer-a": { "ticket-a": supportTicket } };

  first.api.syncSupportAlarm();
  assert.strictEqual(first.nativeCalls.filter((call) => call.type === "start").length, 1, "brand-new support request rings once");

  first.api.syncSupportAlarm();
  first.api.syncSupportAlarm();
  assert.strictEqual(first.nativeCalls.filter((call) => call.type === "start").length, 1, "repeated listeners do not duplicate the same alarm");

  await first.api.openSupportTicket("customer-a", "ticket-a");
  assert.strictEqual(first.nativeCalls.filter((call) => call.type === "stop").length, 1, "opening the request stops the alarm immediately");
  assert.strictEqual(first.patches.length, 1, "opening the request persists one acknowledgement");
  assert.strictEqual(first.patches[0].body.seenActivityAt, 1000, "acknowledgement records the customer activity timestamp");
  assert.ok(first.patches[0].body.seenActivityKey, "acknowledgement records the customer activity fingerprint");
  assert.ok(!Object.prototype.hasOwnProperty.call(first.patches[0].body, "updatedAt"), "admin acknowledgement does not create customer activity");

  first.api.syncSupportAlarm();
  assert.strictEqual(first.nativeCalls.filter((call) => call.type === "start").length, 1, "refresh after acknowledgement does not ring again");

  const restarted = loadAdmin();
  restarted.api.state.support = { "customer-a": { "ticket-a": Object.assign({}, supportTicket, first.patches[0].body) } };
  restarted.api.syncSupportAlarm();
  assert.strictEqual(restarted.nativeCalls.filter((call) => call.type === "start").length, 0, "app restart with persisted acknowledgement does not ring again");

  supportTicket.message = "I need help with my order | customer added a new reply";
  supportTicket.updatedAt = Number(first.patches[0].body.seenAt) + 1;
  first.api.syncSupportAlarm();
  assert.strictEqual(first.nativeCalls.filter((call) => call.type === "start").length, 2, "new customer reply after acknowledgement rings once again");
  first.api.syncSupportAlarm();
  assert.strictEqual(first.nativeCalls.filter((call) => call.type === "start").length, 2, "the same customer reply is not started twice");

  await first.api.openSupportTicket("customer-a", "ticket-a");
  assert.strictEqual(first.nativeCalls.filter((call) => call.type === "stop").length, 2, "opening after the reply stops and acknowledges that activity");

  first.api.state.support["customer-b"] = { "ticket-b": ticket({ id: "ticket-b", uid: "customer-b", message: "A separate customer needs help", createdAt: Date.now() + 2, updatedAt: Date.now() + 2 }) };
  first.api.syncSupportAlarm();
  const starts = first.nativeCalls.filter((call) => call.type === "start");
  assert.strictEqual(starts.length, 3, "a separate new support request rings independently");
  assert.ok(starts[2].body.includes("1 unresolved service request"), "only the separate unacknowledged request remains in the alarm");

  process.stdout.write("✓ Admin support alarm acknowledgements are activity-based and duplicate-safe\n");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
