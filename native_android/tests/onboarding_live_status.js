// Store sign-up, both sides. Restaurant app: the registration screen follows the application live,
// so the rate Scraveit confirms (or a request for changes) shows without the owner doing anything,
// and Check status says where things really stand. Admin app: document links are fetched again
// when they are older than 4 minutes, so a review screen left open for hours still opens them.
// The code under test is cut from each app's premium.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (app) => fs.readFileSync(path.join(__dirname, "..", app, "src/main/assets/premium.js"), "utf8");
const cutter = (src, name) => (from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i); assert.ok(i > 0 && j > i, name + ": can't find " + from); return src.slice(i, j); };
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---- a Firestore document with a live listener ----
const store = new Map(), listeners = new Set();
const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
function docRef(p) {
  const snap = () => ({exists: store.has(p), data: () => clone(store.get(p))});
  return {
    get: async () => snap(),
    set: async (d) => { store.set(p, Object.assign(clone(store.get(p)) || {}, clone(d))); for (const l of [...listeners]) setTimeout(() => listeners.has(l) && l(), 0); },
    onSnapshot(cb) { let last = "__"; const l = () => { const now = JSON.stringify(store.get(p) ?? null); if (now !== last) { last = now; cb(snap()); } }; listeners.add(l); setTimeout(l, 0); return () => listeners.delete(l); },
  };
}

async function restaurantSide() {
  const cut = cutter(read("restaurant"), "restaurant");
  const code = cut("  // A forced load starts again", "  function agreementSheet2(")
    + cut("  async function checkApprovalStatus(", "  function openGoogleSignIn(");
  const UID = "ownerPizzaaaaaaa", APP = "restaurantApplications/" + UID;
  store.set(APP, {uid: UID, status: "submitted", restaurantName: "Pizza and burgers"});
  const toasts = [];
  let failNext = false, renders = 0;
  const ctx = {
    console, setTimeout, clearTimeout, Date, JSON,
    state: {session: {uid: UID}, route: "pending", application: clone(store.get(APP))},
    STORE: {type: "restaurant", noun: "restaurant"}, BRAND: "Scraveit", STANDARD_RATE_PERCENT: 30,
    h: (v) => String(v ?? ""), icon: () => "", friendly: (e) => e.message,
    toast: (m, tone) => toasts.push([m, tone]),
    obIssues: () => [], screenOnboard: () => "ONBOARD", obAppId: () => UID,
    restaurantApplicationDoc: (uid) => docRef("restaurantApplications/" + uid),
    renderSheet() {}, resolveMember: async () => { throw new Error("NOT_A_MEMBER"); },
    sync: async () => {}, startRealtime() {}, ensureNativePushRegistered() {}, routeToPendingOrderIfIdle() {},
    // What getRestaurantAgreement answers, from the application as it is now.
    async econCall(fn, input) {
      assert.equal(fn, "getRestaurantAgreement"); assert.equal(input.appId, UID);
      await tick();
      if (failNext) { failNext = false; throw new Error("Network unavailable."); }
      const terms = store.get(APP).terms || {}, rate = Number.isFinite(Number(terms.commissionBps));
      return {status: rate ? "ready" : "waiting_for_rate", rateAgreed: rate, commissionBps: rate ? terms.commissionBps : 3000, termMonths: terms.termMonths || 12, sections: [], partiesReady: true};
    },
  };
  ctx.render = () => { renders++; ctx.html = ctx.SCREENS.pending(); };
  ctx.SCREENS = {};
  vm.createContext(ctx);
  vm.runInContext(code + "\nSCREENS.pending=screenApplication;", ctx);
  const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

  ctx.render();
  await settle();
  assert.match(ctx.html, /We're checking your details/);
  assert.match(ctx.html, /Standard rate/);
  assert.doesNotMatch(ctx.html, /Read and sign the agreement/);

  // Scraveit confirms 20% in the Admin app: the owner's open screen updates by itself.
  const before = renders;
  await docRef(APP).set({terms: {commissionBps: 2000, termMonths: 12, setAt: Date.now()}});
  await settle();
  assert.ok(renders > before, "the screen redraws when the application changes");
  assert.match(ctx.html, /Your rate is confirmed/);
  assert.match(ctx.html, /Your rate<\/span><strong class="ob-rate-n">20%/);
  assert.match(ctx.html, /Read and sign the agreement/);

  // Check status says what is really going on (it used to say "Still pending Admin review").
  await ctx.checkApprovalStatus();
  assert.deepEqual(toasts.pop(), ["Your rate is confirmed. Read and sign your agreement.", "success"]);

  // A failed load says so, instead of quietly showing the standard rate.
  ctx.state.obAgreement = null; failNext = true;
  await ctx.obLoadAgreement(true);
  ctx.render();
  assert.match(ctx.html, /Couldn't load your rate: Network unavailable\./);
  await ctx.checkApprovalStatus();
  assert.equal(toasts.pop()[0], "Your rate is confirmed. Read and sign your agreement.");
  assert.doesNotMatch(ctx.html, /Couldn't load your rate/);

  // A newer load wins over an older one still on its way.
  ctx.state.obAgreement = null;
  const older = ctx.obLoadAgreement(true);
  await docRef(APP).set({terms: {commissionBps: 1800, termMonths: 12, setAt: Date.now()}});
  await older; await settle();
  assert.equal(ctx.state.obAgreement.commissionBps, 1800);

  // Scraveit asks for changes: the form opens with their message.
  await docRef(APP).set({status: "changes_requested", reviewMessage: "Clearer FSSAI photo please"});
  await settle();
  assert.equal(ctx.html, "ONBOARD");
  assert.equal(ctx.state.application.reviewMessage, "Clearer FSSAI photo please");

  // Leaving the screen stops following the application.
  ctx.state.route = "dashboard";
  await docRef(APP).set({status: "submitted"});
  await settle();
  assert.equal(listeners.size, 0, "no listener left after leaving the registration screen");
  console.log("Restaurant app: rate confirmed shows live, Check status tells the truth, load errors show, changes requested opens the form.");
}

async function adminSide() {
  const src = read("admin"), cut = cutter(src, "admin");
  const code = cut("  function appReviewId(", "  function screenRestaurantAppReview2(")
    + cut("  async function loadLegalSettings(", "  function screenLegalSettings(");
  let now = Date.parse("2026-10-26T12:33:15Z"), calls = 0, fail = false;
  const opened = [], toasts = [];
  const ctx = {
    console, setTimeout, JSON, Number, String, Object,
    Date: {now: () => now},
    state: {selectedRestaurantAppId: "ownerPizzaaaaaaa", route: "restaurantAppReview"},
    h: (v) => String(v ?? ""), friendly: (e) => e.message, render() {},
    toast: (m, tone) => toasts.push([m, tone]),
    location: {assign: (u) => opened.push(u)},
    settingsDocRef: () => ({get: async () => ({exists: true, data: () => ({platformName: "Scraveit", platformAddress: "Nellore", platformEmail: ""})})}),
    async econCall(fn) {
      assert.equal(fn, "getRestaurantApplicationReview");
      calls++;
      if (fail) throw new Error("You're offline.");
      return {links: {fssai: "https://storage.example/fssai?made=" + now}, issues: [], checks: {}};
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  await ctx.loadAppReview(false);
  assert.equal(calls, 1);
  const button = ctx.appDocLink(ctx.state.appReview, "fssai", "FSSAI photo");
  assert.match(button, /data-action="app-doc" data-key="fssai"/);
  assert.doesNotMatch(button, /https:/, "the link itself isn't put in the page, where it would go stale");
  assert.equal(ctx.appDocLink(ctx.state.appReview, "pan", "PAN photo"), "", "no button for a document that isn't there");

  // Opened at once: the link fetched with the screen is still good.
  await ctx.appOpenDoc("fssai");
  assert.equal(calls, 1);
  assert.equal(opened.pop(), "https://storage.example/fssai?made=" + Date.parse("2026-10-26T12:33:15Z"));

  // Two hours later (the screenshot): a new link is fetched before opening.
  now += 2 * 3600000;
  await ctx.appOpenDoc("fssai");
  assert.equal(calls, 2);
  assert.equal(opened.pop(), "https://storage.example/fssai?made=" + now);

  // Offline: says so, opens nothing.
  now += 5 * 60000; fail = true;
  await ctx.appOpenDoc("fssai");
  assert.equal(opened.length, 0);
  assert.deepEqual(toasts.pop(), ["You're offline.", "danger"]);

  // Business details missing: the review warns that the owner can't sign yet.
  assert.equal(ctx.legalMissing(), false, "not known yet, no warning");
  await ctx.loadLegalSettings();
  assert.equal(ctx.legalMissing(), true, "email missing");
  ctx.state.legalSettings = {platformName: "Scraveit", platformAddress: "Nellore", platformEmail: "partners@example.test"};
  assert.equal(ctx.legalMissing(), false);
  ctx.state.legalSettings = {failed: true};
  assert.equal(ctx.legalMissing(), false, "a failed read isn't reported as missing");
  console.log("Admin app: document links are fetched again when old, and missing business details are flagged.");
}

(async () => {
  await restaurantSide();
  await adminSide();
})().catch((e) => { console.error(e); process.exit(1); });
