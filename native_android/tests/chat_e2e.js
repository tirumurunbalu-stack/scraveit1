// Chat end-to-end encryption (assets/chat-e2e.js). The fixed vectors (support/chat_e2e_vector.json)
// were locked by chat-e2e.js and opened by Java's ChatE2eCrypto (the notification code), so both
// agree on the format: version 1 with keys from Java's EC generator, version 2 with WebCrypto keys.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

new Function(fs.readFileSync(path.join(__dirname, "../app/src/main/assets/chat-e2e.js"), "utf8"))();
const E = globalThis.ScraveitE2E;
// Test-only keys, made for these tests. Not used anywhere else.
const V = require("./support/chat_e2e_vector.json");
// Each step below is named for whoever reads a failure.
const step = () => {};
const DAY = 86400000;

(async () => {
  // ---- version 1 (first release): old messages still open ----
  const a = await E.importOwn(V.a), b = await E.importOwn(V.b);
  assert.equal(a.kid, V.a.kid);
  assert.equal((await E.openMessage(b, V.sealed, V.pair, V.from, V.id)).text, V.text);
  assert.equal((await E.openMessage(a, V.sealed, V.pair, V.from, V.id)).card.name, "Chicken Biryani");
  await assert.rejects(E.openMessage(b, V.sealed, V.pair, V.from, "otherId"));
  await assert.rejects(E.openMessage(b, V.sealed, "other_pair", V.from, V.id));
  const bad = Object.assign({}, V.sealed, {ct: (V.sealed.ct[0] === "A" ? "B" : "A") + V.sealed.ct.slice(1)});
  await assert.rejects(E.openMessage(b, bad, V.pair, V.from, V.id));

  // ---- version 2: the fixed message still opens (the format must never change silently) ----
  const F = V.v2, fixedPadhu = await E.loadAccount(F.padhu.bundle), fixedAad = E.msgAad(F.pair, F.from, F.id);
  const fixed = E.messageFrom(await E.openBody(await E.unwrap2(fixedPadhu, F.sealed, F.pair, fixedAad), F.sealed, fixedAad));
  assert.equal(fixed.text, F.text);
  assert.ok(await E.senderOk(F.from, [F.ravi.bundle.id.pub], F.sealed));
  assert.equal(await E.safetyCode("uidRavi", F.ravi.bundle.id.pub, "uidPadhu", F.padhu.bundle.id.pub), F.code);
  assert.ok(await E.checkDirectory("uidPadhu", F.padhu.directory));

  // ---- version 2: the whole life of an account ----
  let now = Date.UTC(2026, 9, 1);
  // Two accounts.
  const ravi = await E.newAccount("uidRavi", now), padhu = await E.newAccount("uidPadhu", now);
  assert.match(ravi.code, /^[0-9A-HJKMNP-TV-Z]{24}$/); step("new account + recovery key " + E.formatCode(ravi.code));
  let rA = await E.loadAccount(ravi.bundle), pA = await E.loadAccount(padhu.bundle);
  const pDir = await E.checkDirectory("uidPadhu", padhu.directory);
  assert.ok(pDir && pDir.agree === padhu.directory.agree); step("directory signature checks");
  assert.equal(await E.checkDirectory("uidPadhu", {...padhu.directory, agree: ravi.directory.agree}), null); step("swapped chat key is refused");
  const pair = "uidPadhu_uidRavi";
  // Message Ravi -> Padhu.
  const {e2e, cek} = await E.sealMessage2(rA, pDir.agree, pair, "uidRavi", "m1", "Biryani at 8? 🍛 హాయ్", {type: "dish", name: "Chicken 65"});
  assert.equal(e2e.w.length, 2);
  const aad = E.msgAad(pair, "uidRavi", "m1");
  const forPadhu = E.messageFrom(await E.openBody(await E.unwrap2(pA, e2e, pair, aad), e2e, aad));
  assert.equal(forPadhu.text, "Biryani at 8? 🍛 హాయ్"); assert.equal(forPadhu.card.name, "Chicken 65"); step("friend opens it");
  assert.ok(await E.senderOk("uidRavi", [ravi.bundle.id.pub], e2e)); assert.ok(!(await E.senderOk("uidRavi", [padhu.bundle.id.pub], e2e))); step("sender checked with identity key");
  const forRavi = E.messageFrom(await E.openBody(await E.unwrap2(rA, e2e, pair, aad), e2e, aad));
  assert.equal(forRavi.text, "Biryani at 8? 🍛 హాయ్"); step("sender's account opens its own message");
  await assert.rejects(E.unwrap2(pA, e2e, pair, E.msgAad(pair, "uidRavi", "m2"))); step("moved message refused");
  // A second phone for Ravi via linking.
  const start = await E.linkStart(), boxed = await E.linkApprove(rA, "req1", start.epk);
  const avk2 = await E.linkFinish(start, "uidRavi", "req1", boxed);
  assert.equal(E.b64(avk2), ravi.bundle.avk); assert.match(start.code, /^\d{3} \d{3}$/); step("phone linking hands over the vault key, code " + start.code);
  let vault = ravi.vault;
  const phone2 = await E.loadAccount(await E.bundleFromVault("uidRavi", vault, avk2, null));
  assert.equal(E.messageFrom(await E.openBody(await E.unwrap2(phone2, e2e, pair, aad), e2e, aad)).text, "Biryani at 8? 🍛 హాయ్"); step("second phone reads history");
  await assert.rejects(E.linkFinish(await E.linkStart(), "uidRavi", "req1", boxed)); step("someone else's request can't open the handover");
  // Rotation after a week; old key still works for 30 days, then retired (forward secrecy).
  now += 8 * DAY;
  let v2 = await E.maintain(rA, vault, now); assert.ok(v2 && v2.epochs[2] && v2.epochs[1]); vault = v2;
  rA = await E.loadAccount(await E.bundleFromVault("uidRavi", vault, E.unb64(ravi.bundle.avk), rA.bundle));
  assert.equal(rA.current.n, 2); assert.equal(E.directoryOf(rA.bundle).epoch, 2);
  assert.ok(await E.checkDirectory("uidRavi", E.directoryOf(rA.bundle))); step("weekly rotation: epoch 2, signed by the same identity");
  assert.equal(await E.maintain(rA, vault, now + DAY), null); step("nothing due the next day");
  const old = E.messageFrom(await E.openBody(await E.unwrap2(rA, e2e, pair, aad), e2e, aad)); assert.equal(old.text, forRavi.text); step("epoch-1 message still opens within 30 days");
  const cacheRec = await E.cacheSeal(rA, "m|" + pair + "|m1", await E.unwrap2(rA, e2e, pair, aad));
  now += 31 * DAY;
  v2 = await E.maintain(rA, vault, now); assert.ok(v2 && !v2.epochs[1] && v2.archive[1] && v2.epochs[3]); vault = v2;
  rA = await E.loadAccount(await E.bundleFromVault("uidRavi", vault, E.unb64(ravi.bundle.avk), rA.bundle));
  await assert.rejects(E.unwrap2(rA, e2e, pair, aad), /NOT_FOR_THIS_PHONE/); step("after 30 days the old key is gone from phones and the vault (forward secrecy)");
  const fromCache = await E.cacheOpen(rA, "m|" + pair + "|m1", cacheRec);
  assert.equal(E.messageFrom(await E.openBody(fromCache, e2e, aad)).text, forRavi.text); step("this phone still shows it from its message-key memory");
  // Restore on a new phone with the recovery key: old keys come back for 30 days.
  await assert.rejects(E.restore("uidRavi", vault, "0000 0000 0000 0000 0000 0000", now), /WRONG_RECOVERY_KEY/); step("wrong recovery key refused");
  const restored = await E.restore("uidRavi", vault, ravi.code.toLowerCase().replace(/(.{4})/g, "$1-"), now);
  const rR = await E.loadAccount(restored.bundle);
  assert.equal(E.messageFrom(await E.openBody(await E.unwrap2(rR, e2e, pair, aad), e2e, aad)).text, forRavi.text); step("recovery key restores full history (typed in lower case with dashes)");
  assert.equal(rR.current.n, 3); step("restored phone sends with the current key");
  // Sign out other phones: new vault key; the second phone can't follow any more.
  const reset = await E.resetVault(rA, vault, now);
  await assert.rejects(E.bundleFromVault("uidRavi", reset.vault, avk2, null), /VAULT_LOCKED/); step("signed-out phone can't open the vault");
  const rA2 = await E.loadAccount(await E.bundleFromVault("uidRavi", reset.vault, reset.avkRaw, rA.bundle));
  assert.equal(rA2.current.n, 4); step("signing out others also starts a new chat key");
  const again = await E.restore("uidRavi", reset.vault, ravi.code, now); assert.equal(E.b64(again.avkRaw), E.b64(reset.avkRaw)); step("recovery key still works after signing out others");
  // New recovery key.
  const nr = await E.newRecovery(rA2, reset.vault);
  await assert.rejects(E.restore("uidRavi", nr.vault, ravi.code, now)); await E.restore("uidRavi", nr.vault, nr.code, now); step("new recovery key replaces the old one");
  // Safety code from identity keys only: the same after rotations.
  const c1 = await E.safetyCode("uidRavi", ravi.bundle.id.pub, "uidPadhu", padhu.bundle.id.pub), c2 = await E.safetyCode("uidPadhu", padhu.bundle.id.pub, "uidRavi", rA2.bundle.id.pub);
  assert.equal(c1, c2); assert.match(c1, /^\d{60}$/); step("safety code stable across rotation");
  // Calls signed by the identity key.
  const sdp = "a=fingerprint:sha-256 AA:BB\r\n", sig = await E.signCall(rA2, "c1", "offer", sdp);
  assert.ok(await E.verifyCall(ravi.bundle.id.pub, sig, "c1", "offer", sdp)); step("call signature by identity key");
  // Photo file.
  const photo = new Uint8Array(4000).map((_, i) => i % 256), pf = await E.sealFile2(rA2, pDir.agree, pair, E.photoAad(pair, "uidRavi", "p1"), "image/jpeg", photo);
  const back = E.fileFrom(await E.openBody(await E.unwrap2(pA, pf.e2e, pair, E.photoAad(pair, "uidRavi", "p1")), pf.e2e, E.photoAad(pair, "uidRavi", "p1")));
  assert.equal(back.mime, "image/jpeg"); assert.equal(back.bytes.length, 4000); step("photo round trip");
  console.log("Chat encryption: v1 and v2 formats, phones, weekly keys, forward secrecy, recovery key, sign-out, calls and safety code OK.");
})().catch((error) => { console.error(error); process.exit(1); });
