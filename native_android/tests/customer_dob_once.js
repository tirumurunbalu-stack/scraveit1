#!/usr/bin/env node
"use strict";

// Founder 20 Nov 2026: "1st time asked was enough". Date of birth must be asked ONCE.
// Two places used to ask: the "Tell us about you" offers step (customerDemographics) and the 13+ age
// check on the home screen (accountAges via accountSetBirthDate). Whichever one is answered must fill
// the other. If a new place asks for a date of birth, add it here.

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
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
  };
}

function makeContext() {
  const storage = new Map();
  const elements = new Map();
  let nextTimer = 1;
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
  const calls = [];
  const context = {
    console, document, localStorage, navigator: { onLine: true }, crypto: webcrypto,
    TextEncoder, AbortController, HTMLFormElement, FormData: global.FormData,
    Image: class Image {}, FEASTLY_FIREBASE: {}, firebase: createFirebaseCompat().firebase,
    fetch: async () => { throw new Error("no network in this test"); },
    setTimeout() { return nextTimer++; }, clearTimeout() {},
    setInterval: () => nextTimer++, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return nextTimer++; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
    FeastlyNative: {
      getCheckoutConfiguration(requestId, token, payloadJson) { calls.push({ op: "price", requestId, payload: JSON.parse(payloadJson) }); },
      createOrder(requestId, token, payloadJson) { calls.push({ op: "order", requestId, payload: JSON.parse(payloadJson) }); },
      createCodOrder(requestId, token, payloadJson) { calls.push({ op: "order", requestId, payload: JSON.parse(payloadJson) }); },
      createClusterOrder(requestId, token, payloadJson) { calls.push({ op: "order", requestId, payload: JSON.parse(payloadJson) }); },
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
const settle = () => new Promise(resolve => setImmediate(resolve));

const original = fs.readFileSync(customerFile, "utf8");
const marker = "bootstrap();";
const index = original.lastIndexOf(marker);
if (index < 0) throw new Error("Customer bootstrap marker was not found");
const instrumented = original.slice(0, index)
  + "render=function(){};toast=function(){};ensureChatSync=function(){};"
  + "socialCall=async function(fn,data){globalThis.__SOCIAL.push([fn,data]);if(globalThis.__SOCIAL_FAIL)throw new Error('offline');return {}};"
  + "globalThis.__DOB={state,chatState,accountHomeCards,screenAboutYou,aboutYouSheet,syncAccountBirthDate,rememberSignupBirthDate,savePendingBirthDate};"
  + original.slice(index + marker.length);
const context = makeContext();
context.__SOCIAL = [];
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });
const api = context.__DOB;
const { state } = api;
const ASK = "Add your date of birth";
const dobCalls = () => context.__SOCIAL.filter(c => c[0] === "accountSetBirthDate");
function freshUser(uid) {
  state.session = { uid, idToken: "t" };
  state.demographics = null; state.demographicsLoaded = true; state.accountDobSynced = ""; state.pendingBirthDate = "";
  const c = api.chatState(); c.account = null; c.accountLoaded = true; c.parentInbox = [];
  context.__SOCIAL.length = 0; context.__SOCIAL_FAIL = false;
}

(async () => {
  // 1. Nobody has given a date of birth yet: the home card asks (once).
  freshUser("u1");
  check(api.accountHomeCards().includes(ASK), "a new account with no date of birth anywhere is asked on the home screen");

  // 2. "Tell us about you" was answered: the home card must NOT ask again, and the date goes to the age check.
  freshUser("u2");
  state.demographics = { gender: "male", birthDate: "1998-07-14", consent: true, updatedAt: 1 };
  check(!api.accountHomeCards().includes(ASK), "after Tell us about you, the home screen does not ask for the date of birth again");
  await settle();
  check(dobCalls().length === 1 && dobCalls()[0][1].birthDate === "1998-07-14", "the About-you date of birth is saved for the age check automatically");
  api.accountHomeCards(); api.accountHomeCards(); await settle();
  check(dobCalls().length === 1, "it is saved once, not on every screen refresh");

  // 3. If that background save fails, the card comes back so the account isn't stuck without an age.
  freshUser("u3");
  context.__SOCIAL_FAIL = true;
  state.demographics = { gender: "", birthDate: "2000-01-02", consent: true, updatedAt: 1 };
  api.accountHomeCards(); await settle(); await settle();
  check(api.accountHomeCards().includes(ASK), "if saving fails (offline), the home card asks as a fallback");

  // 4. The age check was answered first: Tell us about you comes pre-filled with that date.
  freshUser("u4");
  api.chatState().account = { birthDate: "1995-03-09", minor: false };
  check(!api.accountHomeCards().includes(ASK), "an account with a saved date of birth is not asked on the home screen");
  const about = api.screenAboutYou();
  check(/value="1995" selected/.test(about) && /value="03" selected/.test(about) && /value="09" selected/.test(about), "Tell us about you shows the date already given, not empty boxes");
  check(/value="1995" selected/.test(api.aboutYouSheet()), "Account › About you is pre-filled the same way");

  // 5. Sign-up with Google/Apple: the date typed on the sign-up page is saved, so home doesn't ask.
  freshUser("u5");
  context.document.getElementById("signup-dob").value = "2001-11-20";
  api.rememberSignupBirthDate();
  await api.savePendingBirthDate();
  check(dobCalls().length === 1 && dobCalls()[0][1].birthDate === "2001-11-20", "Google/Apple sign-up saves the date typed on the sign-up page");

  // 6. Wording rule: say delivery partners, not riders.
  check(!/riders/.test(api.screenAboutYou()), "the About-you notice says delivery partners, not riders");

  process.stdout.write("customer date-of-birth-once checks passed\n");
})().catch(error => { console.error(error); process.exit(1); });
