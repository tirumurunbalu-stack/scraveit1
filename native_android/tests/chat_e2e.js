// Chat end-to-end encryption (assets/chat-e2e.js). The fixed vector below was made with keys from
// Java's EC key generator (as the Android app makes them) and locked by chat-e2e.js; Java's
// ChatE2eCrypto opened it, so the app and the notification code agree on the format.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

new Function(fs.readFileSync(path.join(__dirname, "../app/src/main/assets/chat-e2e.js"), "utf8"))();
const E = globalThis.ScraveitE2E;
// Test-only keys, made for this file. Not used anywhere else.
const V = {
  "a": {
    "agreePriv": "MEECAQAwEwYHKoZIzj0CAQYIKoZIzj0DAQcEJzAlAgEBBCDZTHzSohtah/2DVHARD18odl+YruOSJhnC+L6KUs119Q==",
    "agreePub": "BIZEYyareiEuWa4upS+/u9E5gNFijfui2EEQXQFsuEmRwbaPyCtcSSZZIlJ1ccsZs9LqTl8oHj9sCUM6CHfIm8A=",
    "signPriv": "MEECAQAwEwYHKoZIzj0CAQYIKoZIzj0DAQcEJzAlAgEBBCBGo2alYc3/oFbzdqtnKeS56pePLUJyRUO07UCSZMMHyg==",
    "signPub": "BDAP178O0VRoCavp+OBDWnOQK7rn1wcfAtF4/znbDXfQTjPZtDcgvy5tBYik0ryOEsjFGI+7HRh8llI1GT2eVmQ=",
    "kid": "33babfe48bea5a54"
  },
  "b": {
    "agreePriv": "MEECAQAwEwYHKoZIzj0CAQYIKoZIzj0DAQcEJzAlAgEBBCBCrpcDZBtAVEkBxUQgEVB1/nJJWdXfnw4Fp42jroK32w==",
    "agreePub": "BPzYDUKhGpvI8Pl6ZhEHUHm7jK9+0YvAsEnroypJ0w6NIUvP9qXCHEQ6IeEeo97MFnC8GaQ0hDNZIHh+oPZt8u0=",
    "signPriv": "MEECAQAwEwYHKoZIzj0CAQYIKoZIzj0DAQcEJzAlAgEBBCCRc8WLrhG1uuDpvILh9rR4kkxISaIxvQxc0D+zcIcpEw==",
    "signPub": "BGta8lhH1cMItzBoRaqRUUHqr5fxbivcM+XBfCYKDf1oTd6mZvLR8XwaI7cdymgr/gl/yjunLp5WWr9QR0Hg0BQ=",
    "kid": "192badd3ec621424"
  },
  "pair": "uidA_uidB",
  "from": "uidA",
  "id": "msg123",
  "text": "హాయ్ Ravi! Biryani at 8? 🍛",
  "sealed": {
    "v": 1,
    "iv": "HVYE+pAAQ+nxK/A8",
    "ct": "ezxsjjLraK7QuMCKsvo+8+TdsI3Fe5288ce07n4tflul4AHST2j5EeE1RVan6YddQZqWhI4YAaV1elcymqZnzF69gO4h0HbXjEEgjUU9fmBxSqpo6bij9lA12JE5SKTWDqJ58NTs7yJS/A==",
    "spk": "BIZEYyareiEuWa4upS+/u9E5gNFijfui2EEQXQFsuEmRwbaPyCtcSSZZIlJ1ccsZs9LqTl8oHj9sCUM6CHfIm8A=",
    "rpk": "BPzYDUKhGpvI8Pl6ZhEHUHm7jK9+0YvAsEnroypJ0w6NIUvP9qXCHEQ6IeEeo97MFnC8GaQ0hDNZIHh+oPZt8u0="
  },
  "code": "572862336274807307431136707076862854086416994691428564267242"
};

(async () => {
  const a = await E.importOwn(V.a), b = await E.importOwn(V.b);
  assert.equal(a.kid, V.a.kid);
  // The fixed message still opens on both phones (the format must never change silently).
  assert.equal((await E.openMessage(b, V.sealed, V.pair, V.from, V.id)).text, V.text);
  assert.equal((await E.openMessage(a, V.sealed, V.pair, V.from, V.id)).card.name, "Chicken Biryani");
  // Moved to another message or chat, or changed by one byte: it won't open.
  await assert.rejects(E.openMessage(b, V.sealed, V.pair, V.from, "otherId"));
  await assert.rejects(E.openMessage(b, V.sealed, "other_pair", V.from, V.id));
  const bad = Object.assign({}, V.sealed, {ct: (V.sealed.ct[0] === "A" ? "B" : "A") + V.sealed.ct.slice(1)});
  await assert.rejects(E.openMessage(b, bad, V.pair, V.from, V.id));
  // A third phone can't open it.
  const c = await E.importOwn(Object.assign({}, V.b, {agreePub: V.a.signPub}));
  await assert.rejects(E.openMessage(c, V.sealed, V.pair, V.from, V.id), /E2E_NOT_FOR_THIS_PHONE/);
  // New messages, photos and voice messages round trip.
  const s = await E.sealMessage(b, V.a.agreePub, V.pair, "uidB", "m2", "Yes! 8 works", null);
  assert.equal((await E.openMessage(a, s, V.pair, "uidB", "m2")).text, "Yes! 8 works");
  const photo = new Uint8Array(3000).map((_, i) => i % 251);
  const f = await E.sealFile(a, V.b.agreePub, V.pair, E.photoAad(V.pair, V.from, "p1"), "image/jpeg", photo);
  const back = await E.openFile(b, f, V.pair, E.photoAad(V.pair, V.from, "p1"));
  assert.equal(back.mime, "image/jpeg");
  assert.deepEqual(Array.from(back.bytes), Array.from(photo));
  await assert.rejects(E.openFile(b, f, V.pair, E.voiceAad(V.pair, V.from, "p1")));
  // Calls: a signature over the DTLS fingerprints; a swapped fingerprint or key is caught.
  const sdp = "v=0\r\na=fingerprint:sha-256 AB:CD:EF:01\r\na=setup:actpass\r\n";
  const sig = await E.signCall(a, "call1", "offer", sdp);
  assert.ok(await E.verifyCall(V.a.signPub, sig, "call1", "offer", sdp));
  assert.ok(!(await E.verifyCall(V.a.signPub, sig, "call1", "answer", sdp)));
  assert.ok(!(await E.verifyCall(V.a.signPub, sig, "call1", "offer", sdp.replace("AB:CD", "AB:CE"))));
  assert.ok(!(await E.verifyCall(V.b.signPub, sig, "call1", "offer", sdp)));
  // The safety code is the same on both phones and doesn't change between versions.
  const k = (x) => ({agree: x.agreePub, sign: x.signPub});
  assert.equal(await E.safetyCode("uidA", k(V.a), "uidB", k(V.b)), V.code);
  assert.equal(await E.safetyCode("uidB", k(V.b), "uidA", k(V.a)), V.code);
  console.log("Chat encryption: format, tamper checks, files, call signatures and safety code OK.");
})().catch((error) => { console.error(error); process.exit(1); });
