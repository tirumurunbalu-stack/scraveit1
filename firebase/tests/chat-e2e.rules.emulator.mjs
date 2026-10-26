// Firestore rules for chat encryption, calls and chat files, checked in the Firestore emulator.
// Needs Java and the emulator; not part of the quick test run. From the repository root:
//   npm i --no-save --prefix /tmp/rules-test firebase-tools@13.35.1 @firebase/rules-unit-testing@3.0.4 firebase@10.14.1
//   ln -sfn /tmp/rules-test/node_modules firebase/tests/node_modules
//   /tmp/rules-test/node_modules/.bin/firebase emulators:exec --only firestore --project demo-e2e \
//     "node firebase/tests/chat-e2e.rules.emulator.mjs"
//   rm firebase/tests/node_modules
import {initializeTestEnvironment, assertSucceeds, assertFails} from "@firebase/rules-unit-testing";
import {doc, setDoc, updateDoc, getDoc, serverTimestamp} from "firebase/firestore";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
// emulators:exec tells the script where the emulator listens.
const emulator = String(process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
const env = await initializeTestEnvironment({projectId: "demo-e2e", firestore: {rules: fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../firestore.rules"), "utf8"), host: emulator[0], port: Number(emulator[1])}});
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "friendships/pA_B"), {status: "accepted", members: ["userAaaaaaaa", "userBbbbbbbb"]});
  for (const u of ["userAaaaaaaa", "userBbbbbbbb"]) await setDoc(doc(db, "chatProfiles/" + u), {status: "active", minor: false});
});
const A = env.authenticatedContext("userAaaaaaaa").firestore(), B = env.authenticatedContext("userBbbbbbbb").firestore();
const pub = "B" + "A".repeat(86) + "=", sealed = (ct) => ({v: 1, iv: "AAAAAAAAAAAAAAAA", ct, spk: pub, rpk: pub});
let n = 0; const t = async (name, p) => { await p; n++; console.log("ok  " + name); };
const dir = (epoch, sign = pub) => ({v: 2, sign, agree: pub, epoch, agreeSig: "c2ln", at: serverTimestamp()});
await t("owner publishes v2 keys", assertSucceeds(setDoc(doc(A, "chatKeys/userAaaaaaaa"), dir(1))));
await t("chat key moves forward", assertSucceeds(setDoc(doc(A, "chatKeys/userAaaaaaaa"), dir(2))));
await t("chat key can't go back", assertFails(setDoc(doc(A, "chatKeys/userAaaaaaaa"), dir(1))));
await t("a new identity starts again at 1", assertSucceeds(setDoc(doc(A, "chatKeys/userAaaaaaaa"), dir(1, "C" + "A".repeat(86) + "="))));
await t("someone else can't", assertFails(setDoc(doc(B, "chatKeys/userAaaaaaaa"), dir(5))));
await t("old v1 shape refused", assertFails(setDoc(doc(A, "chatKeys/userAaaaaaaa"), {agree: pub, sign: pub, at: serverTimestamp()})));
await t("friends read keys", assertSucceeds(getDoc(doc(B, "chatKeys/userAaaaaaaa"))));
const vault = {v: 2, check: {iv: "x", c: "y"}, id: {pub, iv: "x", c: "y"}, epochs: {1: {pub, iv: "x", c: "y", at: 1, sig: "s"}}, archive: {}, rpk: pub, recovery: {salt: "s", iv: "x", c: "y"}, avkr: {epk: pub, iv: "x", c: "y"}};
await t("owner writes the vault", assertSucceeds(setDoc(doc(A, "chatVault/userAaaaaaaa"), vault)));
await t("owner reads the vault", assertSucceeds(getDoc(doc(A, "chatVault/userAaaaaaaa"))));
await t("friend can't read the vault", assertFails(getDoc(doc(B, "chatVault/userAaaaaaaa"))));
const L = (id) => doc(A, "chatLinks/userAaaaaaaa/requests/" + id);
await t("new phone asks to link", assertSucceeds(setDoc(L("r1"), {epk: pub, name: "Samsung M12", status: "pending", at: serverTimestamp()})));
await t("other phone approves with the locked vault key", assertSucceeds(updateDoc(L("r1"), {status: "approved", box: {epk: pub, iv: "x", c: "y"}})));
await t("can't approve twice", assertFails(updateDoc(L("r1"), {status: "declined"})));
await t("friend can't see link requests", assertFails(getDoc(doc(B, "chatLinks/userAaaaaaaa/requests/r1"))));
const m = (id) => doc(A, "chats/pA_B/messages/" + id);
await t("locked message accepted", assertSucceeds(setDoc(m("m1"), {from: "userAaaaaaaa", text: "", e2e: sealed("Zm9v"), at: serverTimestamp()})));
const sealed2 = {v: 2, iv: "AAAAAAAAAAAAAAAA", ct: "Zm9v", epk: pub, spk: pub, se: 3, ss: "c2ln", w: [{k: "0123456789abcdef", iv: "AAAAAAAAAAAAAAAA", c: "Y2Vr"}, {k: "fedcba9876543210", iv: "AAAAAAAAAAAAAAAA", c: "Y2Vr"}]};
await t("v2 locked message accepted", assertSucceeds(setDoc(m("m1b"), {from: "userAaaaaaaa", text: "", e2e: sealed2, at: serverTimestamp()})));
await t("v2 with no wraps refused", assertFails(setDoc(m("m1c"), {from: "userAaaaaaaa", text: "", e2e: {...sealed2, w: []}, at: serverTimestamp()})));
await t("v2 locked voice accepted", assertSucceeds(setDoc(doc(A, "chats/pA_B/voices/v2"), {from: "userAaaaaaaa", e2e: sealed2, ms: 900, at: serverTimestamp()})));
await t("locked message with text rejected", assertFails(setDoc(m("m2"), {from: "userAaaaaaaa", text: "hi", e2e: sealed("Zm9v"), at: serverTimestamp()})));
await t("locked message with card rejected", assertFails(setDoc(m("m3"), {from: "userAaaaaaaa", text: "", card: {type: "dish"}, e2e: sealed("Zm9v"), at: serverTimestamp()})));
await t("bad lock rejected", assertFails(setDoc(m("m4"), {from: "userAaaaaaaa", text: "", e2e: {...sealed("Zm9v"), iv: "short"}, at: serverTimestamp()})));
await t("plain message still accepted", assertSucceeds(setDoc(m("m5"), {from: "userAaaaaaaa", text: "hello", at: serverTimestamp()})));
await t("empty message rejected", assertFails(setDoc(m("m6"), {from: "userAaaaaaaa", text: "", at: serverTimestamp()})));
await t("locked photo accepted", assertSucceeds(setDoc(doc(A, "chats/pA_B/photos/p1"), {from: "userAaaaaaaa", e2e: sealed("Zm9v"), w: 10, h: 10, at: serverTimestamp()})));
await t("plain photo accepted", assertSucceeds(setDoc(doc(A, "chats/pA_B/photos/p2"), {from: "userAaaaaaaa", image: "data:image/jpeg;base64,AAAA", w: 10, h: 10, at: serverTimestamp()})));
await t("photo with both rejected", assertFails(setDoc(doc(A, "chats/pA_B/photos/p3"), {from: "userAaaaaaaa", image: "data:image/jpeg;base64,AAAA", e2e: sealed("Zm9v"), w: 10, h: 10, at: serverTimestamp()})));
await t("locked voice accepted", assertSucceeds(setDoc(doc(A, "chats/pA_B/voices/v1"), {from: "userAaaaaaaa", e2e: sealed("Zm9v"), ms: 1200, at: serverTimestamp()})));
await t("friend reads locked voice", assertSucceeds(getDoc(doc(B, "chats/pA_B/voices/v1"))));
const sig = {k: "0123456789abcdef", s: "c2ln"};
await t("signed call accepted", assertSucceeds(setDoc(doc(A, "calls/c1"), {from: "userAaaaaaaa", to: "userBbbbbbbb", pairId: "pA_B", kind: "video", status: "ringing", offer: {type: "offer", sdp: "v=0"}, offerSig: sig, createdAt: serverTimestamp()})));
await t("bad call signature rejected", assertFails(setDoc(doc(A, "calls/c2"), {from: "userAaaaaaaa", to: "userBbbbbbbb", pairId: "pA_B", kind: "video", status: "ringing", offer: {type: "offer", sdp: "v=0"}, offerSig: {k: "x", s: "y"}, createdAt: serverTimestamp()})));
await t("callee signs the answer", assertSucceeds(updateDoc(doc(B, "calls/c1"), {answer: {type: "answer", sdp: "v=0"}, answerSig: sig, status: "accepted", answeredAt: serverTimestamp()})));
await t("caller can't sign the answer", assertFails(updateDoc(doc(A, "calls/c1"), {answerSig: sig})));
await t("callee marks ringing", assertSucceeds(setDoc(doc(A, "calls/c3"), {from: "userAaaaaaaa", to: "userBbbbbbbb", pairId: "pA_B", kind: "audio", status: "ringing", offer: {type: "offer", sdp: "v=0"}, createdAt: serverTimestamp()}).then(() => updateDoc(doc(B, "calls/c3"), {ringingAt: serverTimestamp()}))));
await env.cleanup();
console.log(n + " rules checks passed");
process.exit(0);
