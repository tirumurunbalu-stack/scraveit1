// The Customer app's end-to-end chat code (premium.js), run as several phones sharing a fake
// Firestore: a first phone sets up the account, a second phone is added by approving it from the
// first, messages lock and unlock on every phone of both accounts, keys rotate weekly and retire
// after 30 days (the phone keeps showing what it showed), the recovery key brings everything back on
// a new phone, "sign out other phones" locks the others out, and calls are signed. The code under
// test is cut from premium.js itself, so this follows the real app.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {webcrypto} = require("node:crypto");

const assets = path.join(__dirname, "../app/src/main/assets");
const app = fs.readFileSync(path.join(assets, "premium.js"), "utf8");
const cut = (from, to) => { const i = app.indexOf(from), j = app.indexOf(to, i); assert.ok(i > 0 && j > i, "premium.js: can't find " + from); return app.slice(i, j); };
const code = cut("  // ---- End-to-end encryption ----", "  // Photos in chats:")
  + cut("  async function sendDm(", "  // ---- Voice messages ----")
  + cut("  async function callTrusted(", "  async function startCall(")
  + cut("  function e2eRevealed(", "  async function chatAction(");
const RAVI = "userRaviaaaaaaaa", PADHU = "userPadhubbbbbbb", PAIR = "pPadhu_Ravi", DAY = 86400000;

// ---- one Firestore for everybody, with live listeners ----
const store = new Map(), listeners = new Set();
let autoId = 0;
const SERVER_TIME = {serverTime: true};
const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
function notify() { for (const l of [...listeners]) setTimeout(() => listeners.has(l) && l.fire(), 0); }
function docRef(p) {
  const snap = () => ({exists: store.has(p), id: p.split("/").pop(), data: () => clone(store.get(p))});
  return {
    id: p.split("/").pop(), path: p,
    collection: (n) => colRef(p + "/" + n),
    get: async () => snap(),
    set: async (d) => { store.set(p, clone(d)); notify(); },
    update: async (d) => { if (!store.has(p)) throw new Error("NOT_FOUND"); store.set(p, Object.assign(clone(store.get(p)), clone(d))); notify(); },
    delete: async () => { store.delete(p); notify(); },
    onSnapshot(cb) { let last = "__"; const l = {fire: () => { const now = JSON.stringify(store.get(p) ?? null); if (now !== last) { last = now; cb(snap()); } }}; listeners.add(l); l.fire(); return () => listeners.delete(l); },
  };
}
function colRef(p) {
  const query = (field, value) => ({
    onSnapshot(cb) {
      const seen = new Set();
      const l = {fire: () => {
        const docs = [...store.entries()].filter(([k, v]) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/") && v[field] === value);
        const added = docs.filter(([k]) => !seen.has(k));
        docs.forEach(([k]) => seen.add(k));
        if (added.length) cb({docChanges: () => added.map(([k, v]) => ({type: "added", doc: {id: k.split("/").pop(), data: () => clone(v)}}))});
      }};
      listeners.add(l); l.fire(); return () => listeners.delete(l);
    },
  });
  return {doc: (id) => docRef(p + "/" + (id || "auto" + (++autoId))), where: (f, _op, v) => query(f, v)};
}
const firestore = {
  collection: (n) => colRef(n),
  async runTransaction(fn) {
    const writes = [];
    const t = {get: (ref) => ref.get(), set: (ref, d) => { writes.push(() => ref.set(d)); }};
    const out = await fn(t);
    for (const w of writes) await w();
    return out;
  },
};

// ---- a phone: its own Android key storage and IndexedDB, and a fresh app session each time ----
function device(uid, name) {
  const native = new Map(), idb = new Map();
  return {uid, name, native, idb, session: () => session(uid, name, native, idb)};
}
function session(uid, name, native, idb) {
  const local = new Map(), state = {sheet: null, route: "dm"}, toasts = [];
  const chat = {pairs: [{id: PAIR, members: [RAVI, PADHU], status: "accepted", names: {[RAVI]: "Ravi Kumar", [PADHU]: "Padhu"}}], threads: {}, threadId: ""};
  const ctx = {
    console, Promise, Map, Set, Date, JSON, Math, Array, Object, String, Number, Error, RegExp, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"), atob: (s) => Buffer.from(s, "base64").toString("binary"),
    crypto: webcrypto, navigator: {userAgent: "Mozilla/5.0 (Linux; Android 13; " + name + " Build/TP1A; wv)", clipboard: {writeText: async () => {}}},
    localStorage: {getItem: (k) => local.has(k) ? local.get(k) : null, setItem: (k, v) => local.set(k, String(v))},
    fs: firestore, firebase: {firestore: {FieldValue: {serverTimestamp: () => SERVER_TIME}}},
    myUid: () => uid, nativeAvailable: (op) => op === "chatKeys",
    nativeInvoke: async (op, p) => {
      assert.equal(op, "chatKeys"); assert.equal(p.uid, uid);
      if (p.op === "get") return {v1: null, v2: clone(native.get("v2")) || null};
      if (p.op === "put") { assert.equal(p.v2.v, 2); native.set("v2", clone(p.v2)); return {ok: true}; }
      if (p.op === "forget") { native.delete("v2"); return {ok: true}; }
      throw new Error("bad op");
    },
    chatState: () => chat, chatRerender: () => {}, state, renderSheet: () => {},
    setSheet: (s) => { state.sheet = s; }, closeSheet: () => { state.sheet = null; }, askConfirm: async () => true,
    sheetShell: (title, copy, html) => "<h2>" + title + "</h2>" + html,
    h: (v) => String(v ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"),
    nameOf: (p, u) => p.names[u], otherOf: (p) => p.members.find((m) => m !== uid),
    callTs: (v) => typeof v === "number" ? v : 0,
    maskPhoneNumbers: (v) => String(v || "").replace(/(?:\+?91[\s.()-]*)?[6-9](?:[\s.()-]*\d){9}/g, "[phone number hidden]"),
    vnClock: (ms) => { const t = Math.round(ms / 1000); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); },
    toast: (m, tone) => { toasts.push([m, tone]); }, chatError: (e) => String(e && (e.userMessage || e.message)),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(assets, "chat-e2e.js"), "utf8"), ctx);
  // IndexedDB stays with the phone between sessions.
  ctx.ScraveitE2E.store = () => ({get: async (k) => idb.get(k) || null, put: async (k, v) => { idb.set(k, v); }});
  vm.runInContext(code + "\n;this.api={e2eAccount,e2ePeer,e2eState,e2eApply,e2eUnlock,lastTextOf,e2eNotice,openE2eInfo,sendDm,callTrusted,e2eRevealed,e2eLinkStart,e2eLinkAnswer,e2eRestore,e2eSignOutOthers,e2eCodeSaved,e2eNewCode,e2e};", ctx);
  return {api: ctx.api, chat, state, toasts, E: ctx.ScraveitE2E};
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const messages = () => [...store.entries()].filter(([p]) => p.startsWith("chats/" + PAIR + "/messages/")).map(([p, d]) => Object.assign({id: p.split("/").pop()}, clone(d)));
async function read(s, m) {
  const list = [Object.assign({}, m)];
  s.chat.threads[PAIR] = list; s.api.e2eApply(PAIR, list); await settle(); s.api.e2eApply(PAIR, list);
  return list[0];
}

(async () => {
  const ravi1 = device(RAVI, "Pixel 8"), ravi2 = device(RAVI, "SM-M127G"), padhu = device(PADHU, "Redmi 12");
  // ---- first phones: each account is set up, with a recovery key to save ----
  let r1 = ravi1.session(), p1 = padhu.session();
  assert.ok(await r1.api.e2eAccount()); assert.ok(await p1.api.e2eAccount());
  const dirR = store.get("chatKeys/" + RAVI);
  assert.equal(dirR.v, 2); assert.equal(dirR.epoch, 1); assert.ok(store.get("chatVault/" + RAVI).avkr);
  const recoveryCode = ravi1.native.get("v2").pendingCode;
  assert.match(recoveryCode, /^[0-9A-HJKMNP-TV-Z]{24}$/);
  await r1.api.e2eCodeSaved();
  assert.equal(ravi1.native.get("v2").pendingCode, undefined);

  // ---- a message: the server only sees the lock; Padhu's phone opens it ----
  await r1.api.sendDm(PAIR, "Biryani at 8? Call 9848022338", null);
  const m1 = messages()[0];
  assert.equal(m1.text, ""); assert.equal(m1.e2e.v, 2); assert.ok(!JSON.stringify(m1).includes("Biryani"));
  assert.equal((await read(p1, m1)).text, "Biryani at 8? Call [phone number hidden]");
  assert.equal((await read(r1, m1)).text, "Biryani at 8? Call [phone number hidden]");
  const pairDoc = Object.assign({}, r1.chat.pairs[0], {lastText: "🔒 Message", lastE2e: Object.assign({}, m1.e2e, {from: RAVI, id: m1.id})});
  p1.api.lastTextOf(pairDoc); await settle();
  assert.equal(p1.api.lastTextOf(pairDoc), "Biryani at 8? Call [phone number hidden]");
  await p1.api.e2ePeer(RAVI);
  assert.equal(p1.api.e2eState(RAVI), "on");

  // ---- Ravi's second phone: not set up yet, so it can't read or send ----
  let r2 = ravi2.session();
  assert.equal(await r2.api.e2eAccount(), null);
  await r2.api.e2ePeer(PADHU);
  assert.equal(r2.api.e2eState(PADHU), "link");
  assert.equal((await read(r2, m1)).e2eError, "link");
  await r2.api.sendDm(PAIR, "hello from phone 2", null);
  assert.equal(r2.state.sheet.type, "e2eSetup");
  assert.ok(!messages().some((m) => m.text === "hello from phone 2"), "never sent unlocked to a friend who has keys");

  // ---- adding it: phone 2 asks, phone 1 sees the same code and approves ----
  await r2.api.e2eLinkStart();
  const waitCode = r2.state.sheet.code;
  await settle(150);
  assert.equal(r1.state.sheet.type, "e2eApprove");
  assert.equal(r1.state.sheet.code, waitCode);
  assert.equal(r1.state.sheet.name, "SM-M127G");
  await r1.api.e2eLinkAnswer(true);
  await settle(300);
  assert.ok(r2.api.e2e.acct, "phone 2 is set up");
  assert.equal((await read(r2, Object.assign({}, m1))).text, "Biryani at 8? Call [phone number hidden]");
  await r2.api.sendDm(PAIR, "Sent from my second phone", null);
  const m2 = messages().find((m) => m.id !== m1.id);
  assert.equal((await read(p1, m2)).text, "Sent from my second phone");
  assert.equal((await read(r1, m2)).text, "Sent from my second phone");

  // ---- the safety code is the same on both accounts' phones ----
  await r1.api.openE2eInfo(PAIR); await p1.api.openE2eInfo(PAIR); await r2.api.openE2eInfo(PAIR);
  assert.match(r1.state.sheet.code, /^\d{60}$/);
  assert.equal(r1.state.sheet.code, p1.state.sheet.code);
  assert.equal(r2.state.sheet.code, p1.state.sheet.code);
  const codeBefore = p1.state.sheet.code;

  // ---- a week later: a new chat key; friends lock new messages for it ----
  const vault = store.get("chatVault/" + RAVI);
  vault.epochs[1].at = Date.now() - 8 * DAY; store.set("chatVault/" + RAVI, vault);
  r1 = ravi1.session(); await r1.api.e2eAccount();
  assert.equal(store.get("chatKeys/" + RAVI).epoch, 2);
  p1 = padhu.session(); await p1.api.e2eAccount();
  await p1.api.sendDm(PAIR, "Yes! 8 works", null);
  const m3 = messages().find((m) => m.from === PADHU);
  assert.equal((await read(r1, m3)).text, "Yes! 8 works");
  assert.equal((await read(r2, m3)).text, "Yes! 8 works", "phone 2, open all along, catches up on the new key");
  r2 = ravi2.session(); await r2.api.e2eAccount();
  assert.equal((await read(r2, m3)).text, "Yes! 8 works", "phone 2 picks up the new key from the vault");
  await p1.api.openE2eInfo(PAIR);
  assert.equal(p1.state.sheet.code, codeBefore, "the safety code doesn't change when keys rotate");
  // Phone 1 shows the old message once more (it remembers its message key).
  assert.equal((await read(r1, m1)).text, "Biryani at 8? Call [phone number hidden]");

  // ---- over 30 days later: the first key leaves the phones and the vault (forward secrecy) ----
  const v2 = store.get("chatVault/" + RAVI);
  v2.epochs[1].at = Date.now() - 45 * DAY; v2.epochs[2].at = Date.now() - 32 * DAY; store.set("chatVault/" + RAVI, v2);
  r1 = ravi1.session(); await r1.api.e2eAccount();
  const v3 = store.get("chatVault/" + RAVI);
  assert.ok(!v3.epochs[1] && v3.archive[1] && v3.epochs[3], "epoch 1 archived, epoch 3 current");
  assert.ok(!ravi1.native.get("v2").epochs[1], "and gone from the phone");
  assert.equal((await read(r1, m1)).text, "Biryani at 8? Call [phone number hidden]", "this phone still shows what it showed");
  // A phone that never showed it can't open it any more without the recovery key.
  ravi2.idb.clear();
  r2 = ravi2.session(); await r2.api.e2eAccount();
  assert.equal((await read(r2, m1)).e2eError, "phone", "the retired key is really gone");
  assert.equal((await read(r2, m3)).text, "Yes! 8 works", "newer messages still open");
  const ravi3 = device(RAVI, "Galaxy A15");
  let r3 = ravi3.session();
  assert.equal(await r3.api.e2eAccount(), null);

  // ---- the recovery key on a new phone brings everything back, the oldest message included ----
  r3.state.sheet = {type: "e2eSetup", mode: "code"};
  await r3.api.e2eRestore("not the key");
  assert.match(r3.state.sheet.error, /24 letters/);
  await r3.api.e2eRestore(recoveryCode.slice(0, 4) + "-" + recoveryCode.slice(4).toLowerCase());
  assert.ok(r3.api.e2e.acct);
  assert.equal((await read(r3, m1)).text, "Biryani at 8? Call [phone number hidden]");

  // ---- sign out other phones: phone 2 can't follow any more and forgets its keys ----
  await r1.api.e2eSignOutOthers();
  assert.ok(r1.toasts.some(([m]) => /signed out/.test(m)));
  r2 = ravi2.session();
  assert.equal(await r2.api.e2eAccount(), null);
  assert.equal(r2.api.e2e.needs, "link");
  assert.equal(ravi2.native.has("v2"), false, "phone 2 forgot the old keys");
  await r1.api.sendDm(PAIR, "After sign-out", null);
  const m4 = messages().find((m) => ![m1.id, m2.id, m3.id].includes(m.id));
  assert.equal((await read(padhu.session(), m4)).text, "After sign-out");

  // ---- calls are signed by the identity key ----
  const sdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n", acct = await r1.api.e2eAccount();
  const sig = await r1.E.signCall(acct, "call1", "offer", sdp), p2 = padhu.session();
  assert.equal(await p2.api.callTrusted(RAVI, sig, "call1", "offer", sdp), true);
  assert.equal(await p2.api.callTrusted(RAVI, sig, "call1", "offer", sdp.replace("AA:BB", "AA:BD")), false);
  assert.equal(await p2.api.callTrusted(RAVI, null, "call1", "offer", sdp), false);

  // ---- a report carries what this phone shows ----
  p2.chat.threads[PAIR] = [await read(p2, m3)];
  assert.deepEqual(p2.api.e2eRevealed(PAIR).map((x) => x.text), ["Yes! 8 works"]);

  // ---- a friend on an older app (no keys) gets plain messages, and the chat says so ----
  store.delete("chatKeys/" + PADHU);
  const r4 = ravi1.session();
  await r4.api.sendDm(PAIR, "plain hello", null);
  assert.ok(messages().some((m) => m.text === "plain hello" && !m.e2e));
  assert.equal(r4.api.e2eState(PADHU), "off");
  console.log("Chat encryption in the app: setup, adding a phone, both accounts' phones, weekly keys, forward secrecy, recovery key, sign-out, calls, reports and older apps OK.");
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
