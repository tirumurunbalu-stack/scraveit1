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

function contextWithPersistedOwner() {
  const storage = new Map();
  const elements = new Map();
  const session = {
    uid: "admin-recovery-owner",
    email: "owner@example.test",
    idToken: "still-valid-id-token",
    refreshToken: "still-valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
    name: "Recovery Owner",
  };
  storage.set("savrivo.control.session", JSON.stringify(session));
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
    FEASTLY_FIREBASE: { databaseUrl: "https://example.invalid" },
    fetch: async () => ({
      ok: false,
      status: 503,
      async text() { return JSON.stringify({ error: { message: "SERVICE_UNAVAILABLE" } }); },
    }),
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
  return vm.createContext(context);
}

(async () => {
  const original = fs.readFileSync(adminFile, "utf8");
  const marker = "bootstrap();";
  const index = original.lastIndexOf(marker);
  if (index < 0) throw new Error("admin bootstrap() call was not found");
  const instrumented = original.slice(0, index)
    + "globalThis.__ADMIN_INTERNALS={state};globalThis.__bootPromise=bootstrap();"
    + original.slice(index + marker.length);
  const context = contextWithPersistedOwner();
  vm.runInContext(instrumented, context, { filename: adminFile, timeout: 3000 });
  await context.__bootPromise;

  const state = context.__ADMIN_INTERNALS.state;
  const stored = JSON.parse(context.localStorage.getItem("savrivo.control.session"));
  if (!state.session || state.session.uid !== "admin-recovery-owner") {
    throw new Error("transient operational sync failure cleared the in-memory Admin session");
  }
  if (!stored || stored.uid !== "admin-recovery-owner") {
    throw new Error("transient operational sync failure cleared the persisted Admin session");
  }
  if (state.role !== "owner" || state.route !== "dashboard") {
    throw new Error(`expected owner dashboard after recovery, got role=${state.role} route=${state.route}`);
  }
  if (!String(state.error || "").trim()) {
    throw new Error("dashboard did not retain the operational sync error for retry messaging");
  }
  const markup = context.document.getElementById("app").innerHTML;
  if (!markup.includes("Reconnecting live operations") || markup.includes("Sign in to")) {
    throw new Error("dashboard did not render the reconnecting state after transient sync failure");
  }
  process.stdout.write("✓ admin: valid session survives transient initial operations sync failure\n");
})().catch(error => {
  process.stderr.write(`✗ admin session recovery: ${error.message}\n`);
  process.exit(1);
});
