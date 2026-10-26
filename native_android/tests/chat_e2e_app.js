// The Customer app's end-to-end chat code (premium.js), run as two phones sharing a fake Firestore:
// a message is locked on one phone and unlocked on the other, the chat list line and safety code
// agree, a key change is noticed, and calls are signed. The code under test is cut from premium.js
// itself (the encryption block and sendDm), so this follows the real app.
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
const V = require("./support/chat_e2e_vector.json");
const A = "userAaaaaaaaaaaaa", B = "userBbbbbbbbbbbbb", PAIR = "pA_B";

// One Firestore shared by both phones.
const store = new Map();
let autoId = 0;
const SERVER_TIME = {serverTime: true};
function docRef(p) {
  return {
    id: p.split("/").pop(),
    collection: (n) => colRef(p + "/" + n),
    get: async () => ({exists: store.has(p), id: p.split("/").pop(), data: () => store.get(p)}),
    set: async (d) => { store.set(p, JSON.parse(JSON.stringify(d))); },
  };
}
function colRef(p) { return {doc: (id) => docRef(p + "/" + (id || "auto" + (++autoId)))}; }
const firestore = {collection: (n) => colRef(n)};

function phone(uid, keys) {
  const local = new Map(), state = {sheet: null, route: "dm"}, renders = {n: 0};
  const chat = {pairs: [{id: PAIR, members: [A, B], status: "accepted", names: {[A]: "Ravi Kumar", [B]: "Padhu"}}], threads: {}, threadId: ""};
  const ctx = {
    console, Promise, Map, Set, Date, JSON, Math, Array, Object, String, Number, Error, RegExp, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"), atob: (s) => Buffer.from(s, "base64").toString("binary"),
    crypto: webcrypto,
    localStorage: {getItem: (k) => local.has(k) ? local.get(k) : null, setItem: (k, v) => local.set(k, String(v))},
    fs: firestore, firebase: {firestore: {FieldValue: {serverTimestamp: () => SERVER_TIME}}},
    myUid: () => uid, nativeAvailable: (op) => op === "chatKeys",
    nativeInvoke: async (op, payload) => { assert.equal(op, "chatKeys"); assert.equal(payload.uid, uid); return keys(); },
    chatState: () => chat, chatRerender: () => { renders.n++; }, state, renderSheet: () => { renders.n++; },
    setSheet: (s) => { state.sheet = s; },
    sheetShell: (title, copy, html) => "<h2>" + title + "</h2>" + html,
    h: (v) => String(v ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"),
    nameOf: (p, u) => p.names[u], otherOf: (p) => p.members.find((m) => m !== uid),
    maskPhoneNumbers: (v) => String(v || "").replace(/(?:\+?91[\s.()-]*)?[6-9](?:[\s.()-]*\d){9}/g, "[phone number hidden]"),
    vnClock: (ms) => { const t = Math.round(ms / 1000); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); },
    toast: (m) => { throw new Error("toast: " + m); }, chatError: (e) => String(e && e.message),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(assets, "chat-e2e.js"), "utf8"), ctx);
  vm.runInContext(code + "\n;this.api={e2eOwn,e2ePeer,e2eState,e2eApply,lastTextOf,e2eNotice,openE2eInfo,sendDm,callTrusted,e2eRevealed,e2e};", ctx);
  return {api: ctx.api, ctx, chat, state, renders, E: ctx.ScraveitE2E};
}
const settle = () => new Promise((r) => setTimeout(r, 60));

(async () => {
  let aKeys = {agreePriv: V.a.agreePriv, agreePub: V.a.agreePub, signPriv: V.a.signPriv, signPub: V.a.signPub};
  const bKeys = {agreePriv: V.b.agreePriv, agreePub: V.b.agreePub, signPriv: V.b.signPriv, signPub: V.b.signPub};
  const ravi = phone(A, () => aKeys), padhu = phone(B, () => bKeys);
  // Each phone publishes its public keys when chat starts.
  await ravi.api.e2eOwn(); await padhu.api.e2eOwn();
  assert.deepEqual(store.get("chatKeys/" + A), {agree: V.a.agreePub, sign: V.a.signPub, at: SERVER_TIME});
  // Ravi sends; the server only ever sees the lock.
  await ravi.api.sendDm(PAIR, "Biryani at 8? Call me on 9848022338", null);
  const [msgPath, stored] = [...store.entries()].find(([p]) => p.startsWith("chats/" + PAIR + "/messages/"));
  assert.equal(stored.text, "");
  assert.equal(stored.card, undefined);
  assert.ok(stored.e2e && stored.e2e.v === 1 && !JSON.stringify(stored).includes("Biryani"));
  // Padhu's phone unlocks it (phone numbers hidden, like plain chat).
  const msgId = msgPath.split("/").pop();
  const thread = [Object.assign({id: msgId}, stored)];
  padhu.chat.threads[PAIR] = thread;
  padhu.api.e2eApply(PAIR, thread);
  assert.equal(thread[0].e2ePending, true);
  await settle();
  padhu.api.e2eApply(PAIR, thread);
  assert.equal(thread[0].text, "Biryani at 8? Call me on [phone number hidden]");
  assert.equal(thread[0].e2ePending, undefined);
  // Ravi's own phone shows what it sent straight away.
  const mine = [Object.assign({id: msgId}, stored)];
  ravi.api.e2eApply(PAIR, mine);
  assert.equal(mine[0].text, "Biryani at 8? Call me on [phone number hidden]");
  // The chat list line, from the lock the server copies into the friendship.
  const pair = Object.assign({}, padhu.chat.pairs[0], {lastText: "🔒 Message", lastE2e: Object.assign({}, stored.e2e, {from: A, id: msgId})});
  assert.equal(padhu.api.lastTextOf(pair), "🔒 Message");
  await settle();
  assert.equal(padhu.api.lastTextOf(pair), "Biryani at 8? Call me on [phone number hidden]");
  // A card (a shared dish) travels inside the lock too.
  await ravi.api.sendDm(PAIR, "", {type: "dish", name: "Chicken 65", restaurantId: "r1"});
  const dish = [...store.entries()].filter(([p]) => p.startsWith("chats/" + PAIR + "/messages/")).map(([p, d]) => Object.assign({id: p.split("/").pop()}, d)).find((m) => m.id !== msgId);
  assert.equal(dish.card, undefined);
  padhu.api.e2eApply(PAIR, [dish]); await settle(); padhu.api.e2eApply(PAIR, [dish]);
  assert.equal(dish.card.name, "Chicken 65");
  // Both phones say the chat is encrypted, and show the same safety code.
  await padhu.api.e2ePeer(A); await ravi.api.e2ePeer(B);
  assert.equal(padhu.api.e2eState(A), "on");
  assert.match(padhu.api.e2eNotice(padhu.chat.pairs[0], A), /end-to-end encrypted/);
  await ravi.api.openE2eInfo(PAIR); await padhu.api.openE2eInfo(PAIR);
  assert.match(ravi.state.sheet.code, /^\d{60}$/);
  assert.equal(ravi.state.sheet.code, padhu.state.sheet.code);
  // A report from Padhu carries what Padhu's phone showed.
  padhu.chat.threads[PAIR] = [thread[0], dish];
  assert.deepEqual(padhu.api.e2eRevealed(PAIR).map((r) => r.text), ["Biryani at 8? Call me on [phone number hidden]", ""]);
  // Calls: Ravi's offer is signed; Padhu's phone accepts it, and refuses a tampered one.
  const sdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n";
  const sig = await ravi.E.signCall(await ravi.api.e2eOwn(), "call1", "offer", sdp);
  assert.equal(await padhu.api.callTrusted(A, sig, "call1", "offer", sdp), true);
  assert.equal(await padhu.api.callTrusted(A, sig, "call1", "offer", sdp.replace("AA:BB", "AA:BD")), false);
  assert.equal(await padhu.api.callTrusted(A, null, "call1", "offer", sdp), false);
  // Ravi reinstalls (new keys): Padhu's phone notices the security code changed.
  const fresh = async (name) => { const k = await webcrypto.subtle.generateKey({name, namedCurve: "P-256"}, true, name === "ECDH" ? ["deriveBits"] : ["sign", "verify"]);
    return [Buffer.from(await webcrypto.subtle.exportKey("pkcs8", k.privateKey)).toString("base64"), Buffer.from(await webcrypto.subtle.exportKey("raw", k.publicKey)).toString("base64")]; };
  const [ap, au] = await fresh("ECDH"), [sp, su] = await fresh("ECDSA");
  aKeys = {agreePriv: ap, agreePub: au, signPriv: sp, signPub: su};
  const ravi2 = phone(A, () => aKeys);
  await ravi2.api.e2eOwn();
  await padhu.api.e2ePeer(A, true);
  assert.match(padhu.api.e2eNotice(padhu.chat.pairs[0], A), /security code changed/);
  // The old message was locked for Ravi's old key: his new phone says so instead of failing silently.
  const old = [Object.assign({id: msgId}, stored)];
  ravi2.api.e2eApply(PAIR, old); await settle(); ravi2.api.e2eApply(PAIR, old);
  assert.equal(old[0].e2eError, "phone");
  // A friend without keys (older app) gets plain messages, and the chat says so.
  store.delete("chatKeys/" + B);
  const ravi3 = phone(A, () => aKeys);
  await ravi3.api.sendDm(PAIR, "plain hello", null);
  const plain = [...store.values()].find((d) => d.text === "plain hello");
  assert.ok(plain && !plain.e2e);
  assert.equal(ravi3.api.e2eState(B), "off");
  console.log("Chat encryption in the app: lock, unlock, chat list, cards, safety code, reports, calls, key change and older apps OK.");
})().catch((error) => { console.error(error); process.exit(1); });
