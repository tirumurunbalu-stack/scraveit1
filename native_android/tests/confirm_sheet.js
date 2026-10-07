#!/usr/bin/env node
"use strict";

// The apps confirm destructive steps with an in-app sheet instead of the
// blocking browser confirm dialog. This drives the real askConfirm()/settleConfirm()
// in each app that uses it: only the confirm button says yes, every other way
// of leaving the sheet says no, and the sheet underneath comes back.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { createFirebaseCompat } = require("./support/firebase_compat_stub");

const nativeRoot = path.resolve(__dirname, "..");
const apps = [
  ["customer", path.join(nativeRoot, "app", "src", "main", "assets", "premium.js"), "\n  bootstrap();"],
  ["restaurant", path.join(nativeRoot, "restaurant", "src", "main", "assets", "premium.js"), "\n  bootstrap();"],
  ["control", path.join(nativeRoot, "admin", "src", "main", "assets", "premium.js"), "\n  if(!window.__SAVRIVO_ADMIN_TEST__)bootstrap();"],
];

function element() {
  return {
    innerHTML: "", value: "", content: "", dataset: {}, style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    firstElementChild: null,
  };
}

function load(file, marker) {
  const source = fs.readFileSync(file, "utf8");
  const index = source.lastIndexOf(marker);
  assert(index >= 0, `${file}: bootstrap marker not found`);
  const instrumented = source.slice(0, index)
    + "\nglobalThis.__CONFIRM={state,setSheet,closeSheet,askConfirm,settleConfirm};"
    + source.slice(index + marker.length);
  const storage = new Map();
  const elements = new Map();
  const document = {
    documentElement: element(), visibilityState: "visible",
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, createElement() { return element(); },
  };
  class HTMLFormElement {}
  const context = {
    console, document, navigator: { onLine: true }, crypto: webcrypto, TextEncoder, AbortController,
    HTMLFormElement, FormData: global.FormData, Image: class Image {}, Intl,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    FEASTLY_FIREBASE: {}, firebase: createFirebaseCompat().firebase,
    fetch: async () => { throw new Error("no network in this test"); },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame() { return 1; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
  };
  context.window = context;
  context.globalThis = context;
  vm.runInContext(instrumented, vm.createContext(context), { filename: file, timeout: 3000 });
  return { api: context.__CONFIRM, sheetRegion: () => elements.get("sheet-region") || element() };
}

(async () => {
  for (const [name, file, marker] of apps) {
    const source = fs.readFileSync(file, "utf8");
    assert(!/\b(?:window\s*\.\s*)?confirm\s*\(/.test(source), `${name}: still calls window.confirm()`);
    const { api } = load(file, marker);

    const yes = api.askConfirm("Decline this booking?", "The customer is told.", "Decline booking", "Keep booking");
    assert.strictEqual(api.state.sheet.type, "confirm", `${name}: the confirm sheet opens`);
    api.settleConfirm(true);
    assert.strictEqual(await yes, true, `${name}: the confirm button resolves yes`);
    assert.strictEqual(api.state.sheet, null, `${name}: nothing was underneath, so no sheet remains`);

    const no = api.askConfirm("Leave?", "", "Leave", "Stay");
    api.settleConfirm(false);
    assert.strictEqual(await no, false, `${name}: the cancel button resolves no`);

    const underneath = { type: "underneath-sheet", id: "kept" };
    api.setSheet(underneath);
    const dismissed = api.askConfirm("Close this table without marking it paid?", "", "Close table", "Keep open");
    api.closeSheet();
    assert.strictEqual(await dismissed, false, `${name}: closing the sheet resolves no`);
    assert.deepStrictEqual(api.state.sheet, underneath, `${name}: the sheet underneath comes back`);

    const first = api.askConfirm("First?", "", "Yes", "No");
    const second = api.askConfirm("Second?", "", "Yes", "No");
    assert.strictEqual(await first, false, `${name}: a superseded confirm resolves no`);
    api.settleConfirm(true);
    assert.strictEqual(await second, true, `${name}: the latest confirm still answers`);
    process.stdout.write(`✓ ${name}: in-app confirm sheet answers yes only on its confirm button\n`);
  }
})().catch(error => {
  process.stderr.write(`✗ confirm sheet: ${error.message}\n`);
  process.exit(1);
});
