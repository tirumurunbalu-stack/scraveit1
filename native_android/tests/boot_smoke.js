#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");

const nativeRoot = path.resolve(__dirname, "..");
const apps = [
  ["customer", path.join(nativeRoot, "app", "src", "main", "assets", "premium.js")],
  ["control", path.join(nativeRoot, "admin", "src", "main", "assets", "premium.js")],
  ["restaurant", path.join(nativeRoot, "restaurant", "src", "main", "assets", "premium.js")],
  ["partner", path.join(nativeRoot, "rider", "src", "main", "assets", "premium.js")],
];

function makeElement() {
  return {
    innerHTML: "",
    value: "",
    content: "",
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
  };
}

function makeContext() {
  const storage = new Map();
  const elements = new Map();
  const document = {
    documentElement: makeElement(),
    visibilityState: "visible",
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    querySelector(selector) {
      return selector === 'meta[name="theme-color"]' ? makeElement() : null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return makeElement(); },
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
    FEASTLY_FIREBASE: {},
    fetch: async () => { throw new Error("unexpected network request during unauthenticated boot"); },
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

async function inspectApp(name, file) {
  const original = fs.readFileSync(file, "utf8");
  const marker = "bootstrap();";
  const index = original.lastIndexOf(marker);
  if (index < 0) throw new Error("bootstrap() call was not found");
  const instrumented = original.slice(0, index)
    + "globalThis.__APP_INTERNALS={state,SCREENS,render};globalThis.__bootPromise=bootstrap();"
    + original.slice(index + marker.length);
  const context = makeContext();
  vm.runInContext(instrumented, context, { filename: file, timeout: 3000 });
  await context.__bootPromise;

  const internals = context.__APP_INTERNALS;
  if (!internals || !internals.SCREENS || typeof internals.render !== "function") {
    throw new Error("screen registry was not exposed during smoke instrumentation");
  }
  if (name === "control") {
    internals.state.session = { uid: "smoke-owner", email: "owner@example.test", name: "Smoke Owner" };
    internals.state.role = "owner";
  } else if (name === "restaurant") {
    internals.state.session = { uid: "smoke-restaurant", email: "restaurant@example.test" };
    internals.state.member = { name: "Smoke Restaurant Owner", role: "restaurant_owner", active: true, restaurantId: "55-bistro", permissions: {} };
    internals.state.restaurant = { id: "55-bistro", name: "Smoke Restaurant", open: true, menu: [] };
  } else if (name === "customer") {
    internals.state.session = { uid: "smoke-customer", email: "customer@example.test" };
  } else if (name === "partner") {
    internals.state.session = { uid: "smoke-partner", email: "partner@example.test" };
    internals.state.profile = { fullName: "Smoke Partner", status: "approved", emailVerified: true };
  }
  const routes = Object.keys(internals.SCREENS);
  if (!routes.length) throw new Error("screen registry is empty");
  for (const route of routes) {
    internals.state.route = route;
    let markup;
    try { markup = internals.SCREENS[route](); }
    catch (error) { throw new Error(`route ${route} failed to render: ${error.message}`); }
    if (typeof markup !== "string" || markup.length === 0) {
      throw new Error(`route ${route} did not return non-empty markup`);
    }
  }
  process.stdout.write(`✓ ${name}: unauthenticated boot and ${routes.length} registered routes render\n`);
}

(async () => {
  const failures = [];
  for (const [name, file] of apps) {
    try { await inspectApp(name, file); }
    catch (error) {
      failures.push(`${name}: ${error.message}`);
      process.stdout.write(`✗ ${name}: boot/render smoke\n`);
    }
  }
  if (failures.length) {
    process.stderr.write("\nBoot/render smoke failures:\n" + failures.map(value => `- ${value}`).join("\n") + "\n");
    process.exit(1);
  }
})();
