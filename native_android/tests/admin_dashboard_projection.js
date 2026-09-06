#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");

const adminFile = path.resolve(__dirname, "..", "admin", "src", "main", "assets", "premium.js");

function element() {
  return {
    innerHTML: "",
    value: "",
    content: "",
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
  };
}

function createContext() {
  const storage = new Map();
  const elements = new Map();
  const databaseReads = [];
  const dashboardPayloads = [];
  storage.set("savrivo.control.session", JSON.stringify({
    uid: "admin-dashboard-owner",
    email: "owner@example.test",
    idToken: "a".repeat(64),
    refreshToken: "b".repeat(64),
    expiresAt: Date.now() + 60 * 60 * 1000,
    name: "Dashboard Owner",
  }));

  const document = {
    documentElement: element(),
    visibilityState: "visible",
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelector(selector) {
      return selector === 'meta[name="theme-color"]' ? element() : null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return element(); },
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  class HTMLFormElement {}
  const context = {
    console,
    document,
    localStorage,
    navigator: { onLine: true },
    crypto: webcrypto,
    TextEncoder,
    AbortController,
    HTMLFormElement,
    FormData: global.FormData,
    Image: class Image {},
    Intl,
    FEASTLY_FIREBASE: { databaseUrl: "https://example.invalid" },
    async fetch(url) {
      databaseReads.push(String(url));
      let value = {};
      if (String(url).includes("/feastly/orders/customer-1/active-order.json")) {
        value = {
          restaurant: "Projection Kitchen",
          status: "Accepted",
          customerName: "Private Customer",
          customerPhone: "9999999999",
          address: { address: "Private delivery address" },
          items: [{ name: "Dosa", quantity: 2, price: 120 }],
          pricing: { subtotal: 240, deliveryFee: 30, platformFee: 10 },
          total: 280,
          updatedAt: 1700000002000,
        };
      }
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify(value); },
      };
    },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    scrollTo() {},
    scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
  };
  context.window = context;
  context.globalThis = context;
  context.SavrivoCloudNative = {
    getAdminDashboard(callbackId, idToken, payloadJson) {
      if (idToken !== "a".repeat(64)) throw new Error("wrong Admin token");
      dashboardPayloads.push(JSON.parse(payloadJson));
      context.SavrivoNativeCallbacks.resolve(callbackId, true, {
        generatedAt: 1700000003000,
        scope: "bounded_operational_snapshot",
        activeOrders: [{
          version: 1,
          source: "functions",
          orderId: "active-order",
          customerId: "customer-1",
          restaurantId: "restaurant-1",
          restaurantName: "Projection Kitchen",
          status: "Accepted",
          active: true,
          paymentMethod: "cod",
          paymentState: "pending",
          total: 280,
          currency: "INR",
          itemCount: 2,
          createdAt: 1700000000000,
          updatedAt: 1700000002000,
        }],
        recentOrders: [{
          version: 1,
          source: "functions",
          orderId: "recent-order",
          customerId: "customer-2",
          restaurantId: "restaurant-2",
          restaurantName: "Recent Kitchen",
          status: "Delivered",
          active: false,
          paymentMethod: "cod",
          paymentState: "captured",
          total: 500,
          currency: "INR",
          itemCount: 1,
          createdAt: 1699999000000,
          updatedAt: 1699999900000,
          terminalAt: 1699999900000,
        }],
        statusCounts: { Accepted: 1, Delivered: 1 },
        finance: {
          scope: "bounded_recent_journals",
          complete: false,
          journalCount: 2,
          invalidJournalCount: 1,
          oldestOccurredAt: 1699999000000,
          newestOccurredAt: 1700000000000,
          eventCounts: { order_placed: 1, order_delivered: 1 },
          windowNetMovementPaise: {
            "liability:restaurant-payable:restaurant-1": 12345,
            "asset:cod-clearing:rider-1": -4567,
          },
        },
        codExposure: {
          scope: "bounded_positive_cod_exposure",
          complete: true,
          truncated: false,
          riderCount: 0,
          invalidWalletCount: 0,
          riders: [],
        },
      });
    },
    registerPushToken(callbackId) {
      context.SavrivoNativeCallbacks.resolve(callbackId, true, { registered: true });
    },
  };
  context.__databaseReads = databaseReads;
  context.__dashboardPayloads = dashboardPayloads;
  return vm.createContext(context);
}

(async () => {
  const original = fs.readFileSync(adminFile, "utf8");
  if (!original.includes('nativeInvoke("getAdminDashboard"')) {
    throw new Error("Admin does not call the bounded dashboard callable");
  }
  if (original.includes('db("GET",ROOT+"/orders")')) {
    throw new Error("Admin still downloads the full customer order tree");
  }
  for (const forbidden of ["adminRevenue", "restaurantNet", "accountBalancesPaise", "15% menu commission", "85%", "SCRAVEIT EARNINGS", "TODAY’S GMV"]) {
    if (original.includes(forbidden)) throw new Error(`Admin still contains inferred finance copy: ${forbidden}`);
  }
  if (!original.includes("RECENT BOUNDED LEDGER WINDOW") || !original.includes("bounded signed activity only")) {
    throw new Error("Admin finance view does not disclose its bounded recent scope");
  }

  const marker = "bootstrap();";
  const index = original.lastIndexOf(marker);
  if (index < 0) throw new Error("admin bootstrap() call was not found");
  const instrumented = original.slice(0, index)
    + "globalThis.__ADMIN_INTERNALS={state,openOrderDetail,screenDashboard,screenFinanceReport,validFinance};globalThis.__bootPromise=bootstrap();"
    + original.slice(index + marker.length);
  const context = createContext();
  vm.runInContext(instrumented, context, { filename: adminFile, timeout: 3000 });
  await context.__bootPromise;

  const internals = context.__ADMIN_INTERNALS;
  const state = internals.state;
  if (context.__dashboardPayloads.length !== 1) throw new Error("bounded dashboard callable was not invoked once during initial sync");
  const payload = context.__dashboardPayloads[0];
  if (payload.activeLimit !== 100 || payload.recentLimit !== 100 || payload.ledgerLimit !== 100 || payload.codLimit !== 100) {
    throw new Error(`unexpected bounded dashboard limits: ${JSON.stringify(payload)}`);
  }
  if (context.__databaseReads.some(url => /\/feastly\/orders\.json(?:\?|$)/.test(url))) {
    throw new Error("initial Admin sync read the unbounded order root");
  }
  if (state.orders.length !== 2 || state.orders[0].id !== "active-order" || state.orders[0].itemCount !== 2) {
    throw new Error("operational order projections were not hydrated correctly");
  }
  if (!state.dashboardFinance || state.dashboardFinance.complete !== false || state.dashboardFinance.invalidJournalCount !== 1
      || state.dashboardFinance.windowNetMovementPaise["asset:cod-clearing:rider-1"] !== -4567) {
    throw new Error("signed recent ledger activity was not preserved");
  }
  if (!state.dashboardCodExposure || state.dashboardCodExposure.complete !== true || state.dashboardCodExposure.riderCount !== 0) {
    throw new Error("bounded COD exposure projection was not hydrated correctly");
  }
  for (const invalid of [
    { scope: "bounded_recent_journals", invalidJournalCount: 0, windowNetMovementPaise: {} },
    { scope: "bounded_recent_journals", complete: true, invalidJournalCount: 1, windowNetMovementPaise: {} },
    { scope: "bounded_recent_journals", complete: false, invalidJournalCount: 0, windowNetMovementPaise: {} },
    { scope: "bounded_recent_journals", complete: false, invalidJournalCount: -1, windowNetMovementPaise: {} },
  ]) {
    let rejected = false;
    try { internals.validFinance(invalid); } catch (_) { rejected = true; }
    if (!rejected) throw new Error(`invalid finance completeness metadata was accepted: ${JSON.stringify(invalid)}`);
  }
  const dashboard = internals.screenDashboard();
  if (!dashboard.includes("VALID JOURNALS") || dashboard.includes("NaN") || dashboard.includes("EARNINGS")) {
    throw new Error("dashboard did not render bounded ledger metrics safely");
  }
  if (!dashboard.includes("Financial snapshot incomplete") || !dashboard.includes("1 invalid journal")) {
    throw new Error("dashboard did not prominently disclose the incomplete finance window");
  }
  const finance = internals.screenFinanceReport();
  if (!finance.includes("liability:restaurant-payable:restaurant-1") || !finance.includes("123.45") || !finance.includes("45.67")) {
    throw new Error("finance view did not render the callable's signed account movements");
  }
  if (!finance.includes("Financial snapshot incomplete") || !finance.includes("windowNetMovementPaise")
      || !finance.includes("bounded signed activity only") || !finance.includes("account balances")
      || !finance.includes("COD figures")) {
    throw new Error("finance view could be mistaken for complete balances, payables or COD figures");
  }

  await internals.openOrderDetail("active-order");
  if (!context.__databaseReads.some(url => url.includes("/feastly/orders/customer-1/active-order.json"))) {
    throw new Error("opening an order did not lazy-load its exact canonical detail");
  }
  if (!state.orderDetails["active-order"] || state.orderDetails["active-order"].items.length !== 1) {
    throw new Error("canonical order details were not cached after the exact read");
  }
  process.stdout.write("✓ admin: bounded dashboard projection, scoped finance activity and lazy order detail\n");
})().catch(error => {
  process.stderr.write(`✗ admin dashboard projection: ${error.message}\n`);
  process.exit(1);
});
