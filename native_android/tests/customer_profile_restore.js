#!/usr/bin/env node
"use strict";

// A customer who clears app data (or reinstalls) starts with an empty profile
// on the phone. The first save after that - usually a GPS reading - must never
// replace the account's saved addresses or phone number with the blank copy.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { createFirebaseCompat } = require("./support/firebase_compat_stub");

const customerFile = path.resolve(__dirname, "..", "app", "src", "main", "assets", "premium.js");
const UID = "cust1";

function makeElement() {
  return {
    innerHTML: "", value: "", content: "", dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
  };
}

function makeContext(firebase) {
  const storage = new Map(), elements = new Map();
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
  const context = {
    console, document, localStorage, navigator: { onLine: true }, crypto: webcrypto,
    TextEncoder, AbortController, HTMLFormElement, FormData: global.FormData,
    Image: class Image {}, FEASTLY_FIREBASE: {}, firebase,
    fetch: async () => { throw new Error("network is not used by this test"); },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return 0; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
  };
  context.window = context;
  context.globalThis = context;
  return vm.createContext(context);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`✓ ${message}\n`);
}

const original = fs.readFileSync(customerFile, "utf8");
const marker = "bootstrap();";
const index = original.lastIndexOf(marker);
if (index < 0) throw new Error("Customer bootstrap marker was not found");
const instrumented = original.slice(0, index)
  + "globalThis.__PROFILE={state,saveProfile,afterAuth,deleteAddress};"
  + original.slice(index + marker.length);

/** A phone with cleared data, signed in to an account that already has `account`. */
function clearedPhone(account, options) {
  const compat = createFirebaseCompat(Object.assign({
    user: { uid: UID, email: "c@example.com", idToken: "token" },
    collections: account ? { users: { [UID]: account } } : {},
  }, options || {}));
  const context = makeContext(compat.firebase);
  vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });
  const { state } = context.__PROFILE;
  state.session = { uid: UID, email: "c@example.com", idToken: "token" };
  state.profile = { name: "", email: "", phone: "", addresses: [], selectedAddressId: "", favourites: [], preferences: {} };
  state.remoteProfileUid = "";
  return { context, state, firestore: compat.firestore };
}

function userWrites(firestore) {
  return firestore.writes.filter(write => write.path === `users/${UID}`);
}

(async () => {
  const home = { id: "addr_home", label: "Home", area: "L A Sagaram", city: "Naidupet", address: "1-1-277, L.A.Sagaram",
    phone: "9652509409", lat: 13.9174, lng: 79.8958, source: "manual", updatedAt: 1000 };

  // 1. A saved "Home", then the first GPS reading on a cleared phone.
  {
    const { context, state, firestore } = clearedPhone({ name: "Tirumuru Balaji", phone: "9652509409", addresses: [home], selectedAddressId: "addr_home", updatedAt: 2000 });
    await context.setDetectedLocation("1-1-277", "L A Sagaram", "Naidupet", "1-1-277, L.A.Sagaram", 13.9174, 79.8958);
    const saved = userWrites(firestore).pop();
    check(Boolean(saved), "the GPS reading is saved to the account");
    const savedHome = saved.data.addresses.find(x => x.id === "addr_home");
    check(Boolean(savedHome) && savedHome.label === "Home" && savedHome.phone === "9652509409", "the saved Home address keeps its name and phone");
    check(saved.data.phone === "9652509409" && saved.data.name === "Tirumuru Balaji", "the account phone and name are not blanked");
    check(state.profile.addresses.some(x => x.id === "addr_home"), "the phone shows the saved Home address again");
  }

  // 2. Older accounts kept "Home" in the GPS slot itself; it must survive too.
  {
    const legacy = Object.assign({}, home, { id: "current-location", source: "gps" });
    const { context, firestore } = clearedPhone({ name: "Tirumuru Balaji", phone: "9652509409", addresses: [legacy], selectedAddressId: "current-location", updatedAt: 2000 });
    await context.setDetectedLocation("1-1-277", "L A Sagaram", "Naidupet", "1-1-277, L.A.Sagaram", 13.9174, 79.8958);
    const saved = userWrites(firestore).pop();
    const kept = saved && saved.data.addresses.find(x => x.id === "current-location");
    check(Boolean(kept) && kept.label === "Home" && kept.phone === "9652509409", "a Home kept in the GPS slot is not renamed or blanked by a new reading");
  }

  // 3. If the account cannot be read (offline), nothing is written over it.
  {
    const { context, firestore } = clearedPhone({ name: "Tirumuru Balaji", phone: "9652509409", addresses: [home], updatedAt: 2000 }, { offline: true });
    await context.setDetectedLocation("1-1-277", "L A Sagaram", "Naidupet", "1-1-277, L.A.Sagaram", 13.9174, 79.8958);
    check(userWrites(firestore).length === 0, "an unreadable account is never overwritten from a cleared phone");
  }

  // 4. A brand-new account (no saved profile yet) still saves normally.
  {
    const { context, firestore } = clearedPhone(null);
    await context.setDetectedLocation("Current location", "L A Sagaram", "Naidupet", "1-1-277, L.A.Sagaram", 13.9174, 79.8958);
    const saved = userWrites(firestore).pop();
    check(Boolean(saved) && saved.data.addresses.length === 1, "a new account's first location is saved");
  }

  // 5. Logging in on a cleared phone brings the saved addresses back.
  {
    const { context, state } = clearedPhone({ name: "Tirumuru Balaji", phone: "9652509409", addresses: [home], selectedAddressId: "addr_home", updatedAt: 2000 });
    await context.__PROFILE.afterAuth();
    for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
    check(state.profile.addresses.some(x => x.id === "addr_home" && x.label === "Home"), "logging in after clearing data shows the saved Home address");
  }

  // 6. A second copy of the app that has never seen "Home" (an old phone, a
  //    simulator) saving its own empty list must not erase it.
  {
    const { context, state, firestore } = clearedPhone({ name: "Tirumuru Balaji", phone: "9652509409", addresses: [home], selectedAddressId: "addr_home", updatedAt: 2000 });
    state.remoteProfileUid = UID; // this copy believes it is already up to date
    state.profile.name = "Tirumuru Balaji"; state.profile.phone = "9652509409";
    await context.__PROFILE.saveProfile();
    const saved = userWrites(firestore).pop();
    check(saved && saved.data.addresses.some(x => x.id === "addr_home"), "another copy of the app saving an empty list keeps the account's Home address");
  }

  // 7. Deleting an address keeps it deleted, even though the account still had it.
  {
    const office = { id: "addr_office", label: "Office", area: "Naidupet", city: "Naidupet", address: "Main road", phone: "9652509409", lat: 13.92, lng: 79.9, source: "manual", updatedAt: 1500 };
    const { context, state, firestore } = clearedPhone({ name: "Tirumuru Balaji", phone: "9652509409", addresses: [home, office], selectedAddressId: "addr_home", updatedAt: 2000 });
    await context.__PROFILE.afterAuth();
    for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
    await context.__PROFILE.deleteAddress("addr_office");
    for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
    const saved = userWrites(firestore).pop();
    check(saved && !saved.data.addresses.some(x => x.id === "addr_office") && saved.data.addresses.some(x => x.id === "addr_home"), "a deleted address stays deleted and the others stay saved");
    check(!state.profile.addresses.some(x => x.id === "addr_office"), "the deleted address is gone from the phone too");
  }

  // 8. The exact failure seen on the phone: right after login the app writes a
  //    small "email verified" note, and reading back too early returned only that
  //    note. The saved addresses must still load.
  {
    const { context, state, firestore } = clearedPhone({ name: "Tirumuru Balaji", phone: "9652509409", addresses: [home], selectedAddressId: "addr_home", updatedAt: 2000 });
    await context.__PROFILE.afterAuth();
    for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
    check(state.profile.addresses.some(x => x.id === "addr_home"), "saved addresses load even when the email flag is written at login");
    const emailWrite = firestore.writes.find(w => w.path === `users/${UID}` && w.data && Object.keys(w.data).length <= 2 && "emailVerified" in w.data);
    check(!emailWrite || !("updatedAt" in emailWrite.data), "the email flag no longer touches the account's updatedAt");
  }

  // 9. "Use current location" at a saved address selects it instead of adding a copy.
  {
    const { context, state, firestore } = clearedPhone({ name: "Tirumuru Balaji", phone: "9652509409", addresses: [home], selectedAddressId: "addr_home", updatedAt: 2000 });
    await context.__PROFILE.afterAuth();
    for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
    await context.setDetectedLocation("1-1-277", "L A Sagaram", "Naidupet", "1-1-277, L.A.Sagaram", 13.91741, 79.89581);
    for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
    const saved = userWrites(firestore).pop();
    check(state.profile.addresses.length === 1 && state.profile.selectedAddressId === "addr_home", "current location at Home selects Home, with no duplicate");
    check(!saved || !saved.data.addresses.some(x => x.id === "current-location"), "no duplicate current-location is saved to the account");
  }

  process.stdout.write("Customer profile restore checks passed.\n");
})().catch(error => { console.error(error); process.exit(1); });
