#!/usr/bin/env node
"use strict";

// Reproduces the archived pre-fix startup pipeline with one stalled Firebase
// profile request. This is a benchmark, not part of the fast regression gate.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { webcrypto } = require("crypto");

const workspace = path.resolve(__dirname, "..", "..");
const sourcePath = path.join(workspace, "Savrivo_Current_Adjustments_Patch", "native_android", "app", "src", "main", "assets", "premium.js");
const original = fs.readFileSync(sourcePath, "utf8");
const marker = "bootstrap();";
const markerAt = original.lastIndexOf(marker);
if (markerAt < 0) throw new Error("archived bootstrap marker missing");
const source = original.slice(0, markerAt)
  + "globalThis.__state=state;globalThis.__bootPromise=bootstrap();"
  + original.slice(markerAt + marker.length);

function node() {
  return {
    innerHTML: "", value: "", content: "", dataset: {}, scrollTop: 0,
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, bottom: 800 }; },
  };
}

const elements = new Map();
const session = { uid: "baseline", email: "baseline@example.test", idToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3600000 };
const profile = {
  name: "Baseline", selectedAddressId: "home", favourites: [], preferences: { theme: "light", notifications: false },
  addresses: [{ id: "home", label: "Home", area: "Naidupeta", city: "Naidupeta", address: "1-1-277", lat: 13.9, lng: 79.89 }],
};
const storage = new Map([
  ["savrivo.customer.seenWelcome", "1"],
  ["savrivo.customer.session", JSON.stringify(session)],
  ["savrivo.customer.profile", JSON.stringify(profile)],
]);
let requests = 0;
const documentElement = node(); documentElement.clientHeight = 800;
const document = {
  documentElement, visibilityState: "visible",
  getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); },
  querySelector(selector) { return selector === 'meta[name="theme-color"]' ? node() : null; },
  querySelectorAll() { return []; }, addEventListener() {}, createElement() { return node(); },
};
const context = {
  console, document, navigator: { onLine: true }, performance, crypto: webcrypto, TextEncoder, AbortController,
  HTMLFormElement: class HTMLFormElement {}, FormData: global.FormData, Image: class Image {},
  FEASTLY_FIREBASE: { apiKey: "test", databaseUrl: "https://example.invalid" },
  localStorage: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); }, removeItem(key) { storage.delete(key); },
  },
  fetch(_url, options) {
    requests += 1;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); });
    });
  },
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  requestAnimationFrame(callback) { callback(); return 1; }, scrollTo() {}, scrollY: 0, innerHeight: 800,
  matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; }, addEventListener() {},
};
context.window = context; context.globalThis = context;

(async () => {
  const started = performance.now();
  const sandbox = vm.createContext(context);
  vm.runInContext(source, sandbox, { filename: sourcePath, timeout: 3000 });
  await sandbox.__bootPromise;
  const elapsedMs = performance.now() - started;
  const markup = elements.get("app").innerHTML;
  process.stdout.write(JSON.stringify({
    elapsedMs: Math.round(elapsedMs * 10) / 10,
    networkRequestsStarted: requests,
    finalRoute: sandbox.__state.route,
    restaurantsVisible: /restaurant-card|Recommended for you|All restaurants/.test(markup),
    stillLaunchPlaceholder: markup.includes("Preparing your Scraveit home"),
  }, null, 2) + "\n");
})().catch(error => { process.stderr.write(error.message + "\n"); process.exit(1); });
