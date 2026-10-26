/* Scraveit chat encryption (end to end).
 *
 * Messages, photos and voice messages are locked on the phone before they leave it; Scraveit's
 * server only stores and forwards locked bytes. The Android app does the same maths to show the
 * text in notifications (ChatE2eCrypto.java).
 *
 * Version 2 (current): an account's phones share one set of keys, kept on each phone (protected by
 * the phone's Keystore) and synced through a vault that is locked with a key only those phones hold.
 *   identity key  ECDSA P-256, permanent: signs the account's chat keys and its calls; the safety
 *                 code friends compare is made from it, so it doesn't change when keys rotate.
 *   chat keys     ECDH P-256, a new one every week ("epochs"), each signed by the identity key and
 *                 published in chatKeys/{uid}. After 30 days an old one is deleted from the phones
 *                 and the vault (forward secrecy): a stolen phone or key opens at most the last month.
 *                 Old ones are kept only in the archive, locked to the recovery key.
 *   recovery key  24 characters (120 bits) the person saves; with it a new phone gets everything back.
 *   message       a fresh random key (CEK) locks the message (AES-256-GCM); the CEK is wrapped for the
 *                 friend's current chat key and the sender's own (so all their phones can read it):
 *                   wrap key = HKDF-SHA256(ECDH(ephemeral, R) || ECDH(sender chat key, R),
 *                              salt "scraveit-chat-v2|" + pairId, info "wrap|" + epk + "|" + spk + "|" + R)
 *                 sealed = {v: 2, iv, ct, epk, spk, se: sender's epoch, ss: its signature, w: [{k: key id of R, iv, c}]}
 *   bound to      additional data "m|pairId|from|messageId" (messages), "p|…|photoId", "v|…|voiceId"
 *   payloads      message = UTF-8 JSON {t, c}; photo/voice = mime type, newline, file bytes
 * Keys are base64 raw uncompressed P-256 points (88 characters); key id = first 16 hex of SHA-256.
 *
 * Version 1 (the first release, one key pair per phone, static ECDH) is still read for old messages.
 *
 * Calls: each side signs its DTLS fingerprints with the identity key, so the server can't sit in
 * the middle of a call without the other phone noticing.
 */
(function (root) {
  "use strict";
  const subtle = root.crypto && root.crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ECDH = { name: "ECDH", namedCurve: "P-256" }, ECDSA = { name: "ECDSA", namedCurve: "P-256" };
  const DAY = 24 * 60 * 60 * 1000, ROTATE_MS = 7 * DAY, KEEP_MS = 30 * DAY;
  const rnd = (n) => root.crypto.getRandomValues(new Uint8Array(n));

  function b64(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(text) {
    const s = atob(String(text || "")), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function hex(bytes) { return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(""); }
  function cat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
  const isPub = (k) => typeof k === "string" && k.length === 88 && /^[A-Za-z0-9+/]+=*$/.test(k);
  async function kidOf(pub) { return hex(await subtle.digest("SHA-256", unb64(pub))).slice(0, 16); }

  // ---------- building blocks ----------
  async function hkdfKey(ikm, salt, info) {
    const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(salt), info: enc.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const aesKey = (raw) => subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  async function gcmSeal(key, bytes, aad) {
    const iv = rnd(12), c = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 }, key, typeof bytes === "string" ? enc.encode(bytes) : bytes);
    return { iv: b64(iv), c: b64(c) };
  }
  async function gcmOpen(key, rec, aad) {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv), additionalData: enc.encode(aad), tagLength: 128 }, key, unb64(rec.c)));
  }
  async function ecdhBits(priv, pub) {
    const peer = await subtle.importKey("raw", unb64(pub), ECDH, false, []);
    return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, priv, 256));
  }
  async function genKeys(alg, extractable) {
    const k = await subtle.generateKey(alg, extractable, alg === ECDH ? ["deriveBits"] : ["sign", "verify"]);
    const pub = b64(await subtle.exportKey("raw", k.publicKey));
    return { priv: k.privateKey, pub, pkcs8: extractable ? b64(await subtle.exportKey("pkcs8", k.privateKey)) : "" };
  }
  const importEcdh = (pkcs8) => subtle.importKey("pkcs8", unb64(pkcs8), ECDH, false, ["deriveBits"]);
  const importEcdsa = (pkcs8) => subtle.importKey("pkcs8", unb64(pkcs8), ECDSA, false, ["sign"]);
  async function sign(priv, text) { return b64(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(text))); }
  async function verify(pub, text, sig) {
    if (!isPub(pub) || typeof sig !== "string") return false;
    try {
      const key = await subtle.importKey("raw", unb64(pub), ECDSA, false, ["verify"]);
      return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(sig), enc.encode(text));
    } catch (_) { return false; }
  }
  /** Locks bytes to a public key: a throwaway key pair, ECDH, HKDF, AES-GCM. */
  async function box(toPub, bytes, label) {
    const e = await genKeys(ECDH, false), key = await hkdfKey(await ecdhBits(e.priv, toPub), "scraveit-box-v1", label + "|" + e.pub + "|" + toPub);
    return Object.assign({ epk: e.pub }, await gcmSeal(key, bytes, label));
  }
  async function openBox(priv, myPub, rec, label) {
    const key = await hkdfKey(await ecdhBits(priv, rec.epk), "scraveit-box-v1", label + "|" + rec.epk + "|" + myPub);
    return gcmOpen(key, rec, label);
  }

  const msgAad = (pairId, from, id) => "m|" + pairId + "|" + from + "|" + id;
  const photoAad = (pairId, from, id) => "p|" + pairId + "|" + from + "|" + id;
  const voiceAad = (pairId, from, id) => "v|" + pairId + "|" + from + "|" + id;
  const messageBytes = (text, card) => enc.encode(JSON.stringify({ t: String(text || ""), c: card || null }));
  function messageFrom(bytes) {
    const v = JSON.parse(dec.decode(bytes));
    return { text: typeof v.t === "string" ? v.t : "", card: v.c && typeof v.c === "object" ? v.c : null };
  }
  const fileBytes = (mime, bytes) => cat(enc.encode(String(mime) + "\n"), bytes);
  function fileFrom(all) {
    const nl = all.indexOf(10);
    if (nl < 1 || nl > 80) throw new Error("E2E_BAD_FILE");
    return { mime: dec.decode(all.subarray(0, nl)), bytes: all.subarray(nl + 1) };
  }

  // ---------- version 1 (first release): read old messages ----------
  async function importOwn(k) {
    if (!k || !isPub(k.agreePub) || !isPub(k.signPub)) throw new Error("E2E_KEYS_INVALID");
    return { agree: await importEcdh(k.agreePriv), sign: await importEcdsa(k.signPriv), agreePub: k.agreePub, signPub: k.signPub, kid: await kidOf(k.agreePub) };
  }
  const v1Keys = new Map();
  async function chatKey(own, theirPub, pairId) {
    if (!isPub(theirPub)) throw new Error("E2E_PEER_KEY_INVALID");
    const id = own.agreePub + "|" + theirPub + "|" + pairId;
    if (!v1Keys.has(id)) {
      const p = (async () => hkdfKey(await ecdhBits(own.agree, theirPub), "scraveit-chat-v1|" + pairId, "chat"))();
      v1Keys.set(id, p); p.catch(() => v1Keys.delete(id));
    }
    return v1Keys.get(id);
  }
  async function seal(own, theirPub, pairId, aad, data) {
    const rec = await gcmSeal(await chatKey(own, theirPub, pairId), typeof data === "string" ? enc.encode(data) : data, aad);
    return { v: 1, iv: rec.iv, ct: rec.c, spk: own.agreePub, rpk: theirPub };
  }
  async function open(own, sealed, pairId, aad) {
    if (!sealed || sealed.v !== 1) throw new Error("E2E_UNKNOWN_FORMAT");
    const theirPub = sealed.spk === own.agreePub ? sealed.rpk : sealed.rpk === own.agreePub ? sealed.spk : "";
    if (!theirPub) throw new Error("E2E_NOT_FOR_THIS_PHONE");
    return gcmOpen(await chatKey(own, theirPub, pairId), { iv: sealed.iv, c: sealed.ct }, aad);
  }
  const sealMessage = (own, theirPub, pairId, from, id, text, card) => seal(own, theirPub, pairId, msgAad(pairId, from, id), messageBytes(text, card));
  const openMessage = async (own, sealed, pairId, from, id) => messageFrom(await open(own, sealed, pairId, msgAad(pairId, from, id)));
  const sealFile = (own, theirPub, pairId, aad, mime, bytes) => seal(own, theirPub, pairId, aad, fileBytes(mime, bytes));
  const openFile = async (own, sealed, pairId, aad) => fileFrom(await open(own, sealed, pairId, aad));

  // ---------- version 2: the account ----------
  const epochText = (uid, n, pub) => "scraveit-epoch-v1|" + uid + "|" + n + "|" + pub;
  const verifyEpoch = (signPub, uid, n, pub, sig) => verify(signPub, epochText(uid, n, pub), sig);

  /**
   * The account on this phone, from the bundle the Android app keeps:
   * {v: 2, uid, id: {priv, pub}, avk, cache, epochs: {n: {priv, pub, at, sig, until?}}, pendingCode?}
   */
  async function loadAccount(bundle) {
    if (!bundle || bundle.v !== 2 || !bundle.id || !isPub(bundle.id.pub)) throw new Error("E2E_BUNDLE_INVALID");
    const epochs = new Map(), byN = [];
    for (const [n, e] of Object.entries(bundle.epochs || {})) {
      if (e.until && e.until < Date.now()) continue;
      const k = { n: Number(n), pub: e.pub, priv: await importEcdh(e.priv), at: Number(e.at) || 0, sig: e.sig };
      epochs.set(await kidOf(e.pub), k); byN.push(k);
    }
    const current = byN.filter((k) => k.sig && bundle.epochs[k.n] && !bundle.epochs[k.n].until).sort((a, b) => b.n - a.n)[0];
    if (!current) throw new Error("E2E_BUNDLE_INVALID");
    return {
      uid: bundle.uid, bundle, epochs, current, sign: await importEcdsa(bundle.id.priv), signPub: bundle.id.pub,
      avk: await aesKey(unb64(bundle.avk)), cacheKey: await aesKey(unb64(bundle.cache)),
    };
  }
  /** What friends see in chatKeys/{uid}: the identity key and the current, signed chat key. */
  function directoryOf(bundle) {
    const [n, e] = Object.entries(bundle.epochs).filter(([, x]) => x.sig && !x.until).sort((a, b) => Number(b[0]) - Number(a[0]))[0];
    return { v: 2, sign: bundle.id.pub, agree: e.pub, epoch: Number(n), agreeSig: e.sig };
  }
  /** A friend's chatKeys document, checked: its chat key must be signed by its identity key. */
  async function checkDirectory(uid, doc) {
    if (!doc || doc.v !== 2 || !isPub(doc.sign) || !isPub(doc.agree) || !(doc.epoch >= 1)) return null;
    return (await verifyEpoch(doc.sign, uid, doc.epoch, doc.agree, doc.agreeSig)) ? { sign: doc.sign, agree: doc.agree, epoch: doc.epoch } : null;
  }

  async function lockEpoch(avk, uid, n, k, now) {
    return Object.assign({ pub: k.pub, at: now, sig: k.sig }, await gcmSeal(avk, unb64(k.pkcs8), "epoch|" + uid + "|" + n));
  }

  // ----- recovery key -----
  const CODE_ABC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function newCode() {
    const bytes = rnd(15); let bits = 0, acc = 0, out = "";
    for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += CODE_ABC[(acc >> bits) & 31]; } }
    return out;
  }
  function normalizeCode(text) {
    const s = String(text || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
    return /^[0-9A-HJKMNP-TV-Z]{24}$/.test(s) ? s : "";
  }
  const formatCode = (code) => String(code).match(/.{1,4}/g).join(" ");
  async function makeRecovery(uid, avkRaw) {
    const code = newCode(), r = await genKeys(ECDH, true), salt = b64(rnd(16));
    const key = await hkdfKey(enc.encode(code), salt, "scraveit-recovery-v1|" + uid);
    return { code, rpk: r.pub, recovery: Object.assign({ salt }, await gcmSeal(key, unb64(r.pkcs8), "recovery|" + uid)), avkr: await box(r.pub, avkRaw, "avk|" + uid) };
  }

  /**
   * A brand-new account (its first phone): identity, vault key, first chat key and recovery key.
   * Returns the bundle to keep on the phone, the vault and directory documents, and the recovery key.
   */
  async function newAccount(uid, now) {
    const id = await genKeys(ECDSA, true), e = await genKeys(ECDH, true), avkRaw = rnd(32), avk = await aesKey(avkRaw);
    e.sig = await sign(id.priv, epochText(uid, 1, e.pub));
    const rec = await makeRecovery(uid, avkRaw);
    const vault = {
      v: 2, check: await gcmSeal(avk, enc.encode("scraveit-vault"), "check|" + uid),
      id: Object.assign({ pub: id.pub }, await gcmSeal(avk, unb64(id.pkcs8), "id|" + uid)),
      epochs: { 1: await lockEpoch(avk, uid, 1, e, now) }, archive: {},
      rpk: rec.rpk, recovery: rec.recovery, avkr: rec.avkr,
    };
    const bundle = { v: 2, uid, id: { priv: id.pkcs8, pub: id.pub }, avk: b64(avkRaw), cache: b64(rnd(32)), epochs: { 1: { priv: e.pkcs8, pub: e.pub, at: now, sig: e.sig } }, pendingCode: rec.code };
    return { bundle, vault, directory: directoryOf(bundle), code: rec.code };
  }

  /** This phone's bundle from the vault (another phone may have rotated or retired keys). */
  async function bundleFromVault(uid, vault, avkRaw, keep) {
    const avk = await aesKey(avkRaw);
    try { await gcmOpen(avk, vault.check, "check|" + uid); } catch (_) { throw new Error("E2E_VAULT_LOCKED"); }
    const idPriv = b64(await gcmOpen(avk, vault.id, "id|" + uid)), epochs = {};
    for (const [n, e] of Object.entries(vault.epochs || {})) epochs[n] = { priv: b64(await gcmOpen(avk, e, "epoch|" + uid + "|" + n)), pub: e.pub, at: e.at, sig: e.sig };
    const now = Date.now();
    // Old keys brought back with the recovery key stay a while, so old chats can be read again.
    for (const [n, e] of Object.entries((keep && keep.epochs) || {})) if (e.until && e.until > now && !epochs[n]) epochs[n] = e;
    const bundle = { v: 2, uid, id: { priv: idPriv, pub: vault.id.pub }, avk: b64(avkRaw), cache: (keep && keep.cache) || b64(rnd(32)), epochs };
    if (keep && keep.pendingCode) bundle.pendingCode = keep.pendingCode;
    return bundle;
  }

  /**
   * Weekly upkeep on the vault: a new chat key when the current one is a week old; keys whose
   * successor is over 30 days old move to the archive (locked to the recovery key) and leave the
   * vault and the phones. Returns null when nothing is due.
   */
  async function maintain(acct, vault, now) {
    const uid = acct.uid, avk = acct.avk, out = JSON.parse(JSON.stringify(vault));
    const ns = Object.keys(out.epochs).map(Number).sort((a, b) => a - b), top = ns[ns.length - 1];
    let changed = false;
    if (now - Number(out.epochs[top].at) >= ROTATE_MS) {
      const e = await genKeys(ECDH, true);
      e.sig = await sign(acct.sign, epochText(uid, top + 1, e.pub));
      out.epochs[top + 1] = await lockEpoch(avk, uid, top + 1, e, now);
      changed = true;
    }
    const rkid = await kidOf(out.rpk);
    for (const n of Object.keys(out.epochs).map(Number)) {
      const next = out.epochs[n + 1] || out.archive[n + 1];
      if (!next || now - Number(next.at) < KEEP_MS) continue;
      const e = out.epochs[n], priv = await gcmOpen(avk, e, "epoch|" + uid + "|" + n);
      out.archive[n] = Object.assign({ pub: e.pub, at: e.at, sig: e.sig, r: rkid }, await box(out.rpk, priv, "epoch|" + uid + "|" + n));
      delete out.epochs[n];
      changed = true;
    }
    return changed ? out : null;
  }

  /** A new recovery key (the old one stops working; keys archived before stay locked to the old one). */
  async function newRecovery(acct, vault) {
    const rec = await makeRecovery(acct.uid, unb64(acct.bundle.avk));
    return { vault: Object.assign(JSON.parse(JSON.stringify(vault)), { rpk: rec.rpk, recovery: rec.recovery, avkr: rec.avkr }), code: rec.code };
  }

  /**
   * "Sign out other phones": a new vault key (phones that only had the old one can't follow any more)
   * and a new chat key straight away. The vault is locked again with the new key.
   */
  async function resetVault(acct, vault, now) {
    const uid = acct.uid, oldAvk = acct.avk, avkRaw = rnd(32), avk = await aesKey(avkRaw), out = JSON.parse(JSON.stringify(vault));
    out.check = await gcmSeal(avk, enc.encode("scraveit-vault"), "check|" + uid);
    out.id = Object.assign({ pub: vault.id.pub }, await gcmSeal(avk, await gcmOpen(oldAvk, vault.id, "id|" + uid), "id|" + uid));
    for (const [n, e] of Object.entries(vault.epochs)) out.epochs[n] = Object.assign({ pub: e.pub, at: e.at, sig: e.sig }, await gcmSeal(avk, await gcmOpen(oldAvk, e, "epoch|" + uid + "|" + n), "epoch|" + uid + "|" + n));
    const top = Math.max(...Object.keys(out.epochs).map(Number)), e = await genKeys(ECDH, true);
    e.sig = await sign(acct.sign, epochText(uid, top + 1, e.pub));
    out.epochs[top + 1] = await lockEpoch(avk, uid, top + 1, e, now);
    out.avkr = await box(out.rpk, avkRaw, "avk|" + uid);
    return { vault: out, avkRaw };
  }

  /** Everything back on a new phone with the recovery key, old chat keys included (for 30 days). */
  async function restore(uid, vault, codeText, now) {
    const code = normalizeCode(codeText);
    if (!code) throw new Error("E2E_RECOVERY_KEY_FORMAT");
    let rpkPriv;
    try {
      const key = await hkdfKey(enc.encode(code), vault.recovery.salt, "scraveit-recovery-v1|" + uid);
      rpkPriv = await importEcdh(b64(await gcmOpen(key, vault.recovery, "recovery|" + uid)));
    } catch (_) { throw new Error("E2E_WRONG_RECOVERY_KEY"); }
    const avkRaw = await openBox(rpkPriv, vault.rpk, vault.avkr, "avk|" + uid);
    const bundle = await bundleFromVault(uid, vault, avkRaw, null), rkid = await kidOf(vault.rpk);
    for (const [n, a] of Object.entries(vault.archive || {})) {
      if (a.r !== rkid || bundle.epochs[n]) continue;
      try { bundle.epochs[n] = { priv: b64(await openBox(rpkPriv, vault.rpk, a, "epoch|" + uid + "|" + n)), pub: a.pub, at: a.at, sig: a.sig, until: now + KEEP_MS }; } catch (_) { /* skip a damaged entry */ }
    }
    return { bundle, avkRaw };
  }

  // ----- adding a phone -----
  async function linkCode(epk) {
    const d = new Uint8Array(await subtle.digest("SHA-256", enc.encode("scraveit-link-v1|" + epk)));
    return String(((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3]).slice(-6).padStart(6, "0").replace(/(\d{3})(\d{3})/, "$1 $2");
  }
  /** The new phone: a throwaway key for the request, and the code both phones show. */
  async function linkStart() { const e = await genKeys(ECDH, false); return { priv: e.priv, epk: e.pub, code: await linkCode(e.pub) }; }
  /** The phone that approves: the vault key, locked to the new phone's request. */
  const linkApprove = (acct, reqId, epk) => box(epk, unb64(acct.bundle.avk), "link|" + acct.uid + "|" + reqId);
  const linkFinish = (start, uid, reqId, rec) => openBox(start.priv, start.epk, rec, "link|" + uid + "|" + reqId);

  // ----- messages -----
  /** Locks bytes for a chat: a fresh key, wrapped for the friend's chat key and the sender's own. */
  async function seal2(acct, peerAgree, pairId, aad, bytes) {
    if (!isPub(peerAgree)) throw new Error("E2E_PEER_KEY_INVALID");
    const cek = rnd(32), body = await gcmSeal(await aesKey(cek), bytes, aad), e = await genKeys(ECDH, false), cur = acct.current;
    const w = [];
    for (const R of Array.from(new Set([peerAgree, cur.pub]))) {
      const wk = await hkdfKey(cat(await ecdhBits(e.priv, R), await ecdhBits(cur.priv, R)), "scraveit-chat-v2|" + pairId, "wrap|" + e.pub + "|" + cur.pub + "|" + R);
      w.push(Object.assign({ k: await kidOf(R) }, await gcmSeal(wk, cek, aad)));
    }
    return { e2e: { v: 2, iv: body.iv, ct: body.c, epk: e.pub, spk: cur.pub, se: cur.n, ss: cur.sig, w }, cek };
  }
  /** The message's own key, unwrapped with whichever of this account's chat keys it was locked for. */
  async function unwrap2(acct, e2e, pairId, aad) {
    for (const entry of Array.isArray(e2e.w) ? e2e.w : []) {
      const k = acct.epochs.get(entry.k);
      if (!k) continue;
      const wk = await hkdfKey(cat(await ecdhBits(k.priv, e2e.epk), await ecdhBits(k.priv, e2e.spk)), "scraveit-chat-v2|" + pairId, "wrap|" + e2e.epk + "|" + e2e.spk + "|" + k.pub);
      return gcmOpen(wk, entry, aad);
    }
    throw new Error("E2E_NOT_FOR_THIS_PHONE");
  }
  /** Did the sender's own identity key sign the chat key this was sent with? */
  async function senderOk(senderUid, signPubs, e2e) {
    for (const pub of signPubs || []) if (await verifyEpoch(pub, senderUid, e2e.se, e2e.spk, e2e.ss)) return true;
    return false;
  }
  const openBody = async (cek, e2e, aad) => gcmOpen(await aesKey(cek), { iv: e2e.iv, c: e2e.ct }, aad);
  const sealMessage2 = (acct, peerAgree, pairId, from, id, text, card) => seal2(acct, peerAgree, pairId, msgAad(pairId, from, id), messageBytes(text, card));
  const sealFile2 = (acct, peerAgree, pairId, aad, mime, bytes) => seal2(acct, peerAgree, pairId, aad, fileBytes(mime, bytes));

  // ----- this phone's memory of message keys (forward secrecy keeps chats readable here) -----
  const cacheSeal = (acct, key, cek) => gcmSeal(acct.cacheKey, cek, "cek|" + key);
  const cacheOpen = (acct, key, rec) => gcmOpen(acct.cacheKey, rec, "cek|" + key);
  /** A small key-value store in IndexedDB (a Map where there's none, e.g. tests). */
  function store(name) {
    const mem = new Map();
    let db = null;
    if (root.indexedDB) {
      db = new Promise((ok) => {
        try {
          const req = root.indexedDB.open(name, 1);
          req.onupgradeneeded = () => req.result.createObjectStore("kv");
          req.onsuccess = () => ok(req.result); req.onerror = () => ok(null);
        } catch (_) { ok(null); }
      });
    }
    const tx = async (mode, fn) => {
      const d = db && await db;
      if (!d) return fn(null);
      return new Promise((ok) => {
        try { const t = d.transaction("kv", mode), s = t.objectStore("kv"), r = fn(s); t.oncomplete = () => ok(r && r.result); t.onerror = () => ok(undefined); }
        catch (_) { ok(undefined); }
      });
    };
    return {
      async get(k) { if (mem.has(k)) return mem.get(k); const v = await tx("readonly", (s) => s ? s.get(k) : null); if (v) mem.set(k, v); return v || null; },
      async put(k, v) { mem.set(k, v); await tx("readwrite", (s) => s ? s.put(v, k) : null); },
    };
  }

  // ---------- calls ----------
  function callStatement(callId, side, sdp) {
    const prints = String(sdp || "").split(/\r?\n/).filter((l) => /^a=fingerprint:/i.test(l)).map((l) => l.trim().toLowerCase()).sort();
    return "scraveit-call-v1|" + callId + "|" + side + "|" + prints.join("|");
  }
  async function signCall(own, callId, side, sdp) { return { k: await kidOf(own.signPub), s: await sign(own.sign, callStatement(callId, side, sdp)) }; }
  async function verifyCall(signPub, sig, callId, side, sdp) {
    if (!sig || typeof sig.s !== "string" || !/a=fingerprint:/i.test(String(sdp || ""))) return false;
    return verify(signPub, callStatement(callId, side, sdp), sig.s);
  }

  // ---------- safety code ----------
  /**
   * The code two friends compare to be sure no one swapped their keys: 60 digits, the same on both
   * phones, 30 from each person's identity key (so weekly key changes don't change it).
   */
  async function safetyCode(uidA, signA, uidB, signB) {
    const half = async (uid, pub) => {
      let d = new Uint8Array(await subtle.digest("SHA-256", enc.encode("scraveit-safety-v2|" + uid + "|" + pub)));
      for (let i = 0; i < 1023; i++) d = new Uint8Array(await subtle.digest("SHA-256", d));
      let out = "";
      for (let i = 0; i < 30; i += 5) out += String(((d[i] * 2 ** 32) + ((d[i + 1] << 24) >>> 0) + (d[i + 2] << 16) + (d[i + 3] << 8) + d[i + 4]) % 100000).padStart(5, "0");
      return out;
    };
    const [first, second] = uidA < uidB ? [[uidA, signA], [uidB, signB]] : [[uidB, signB], [uidA, signA]];
    return (await half(first[0], first[1])) + (await half(second[0], second[1]));
  }

  root.ScraveitE2E = {
    available: !!(subtle && root.TextEncoder), ROTATE_MS, KEEP_MS,
    b64, unb64, isPub, kidOf, photoAad, voiceAad, msgAad, messageFrom, fileFrom,
    // version 1
    importOwn, sealMessage, openMessage, sealFile, openFile,
    // version 2
    loadAccount, directoryOf, checkDirectory, newAccount, bundleFromVault, maintain, newRecovery, resetVault, restore,
    normalizeCode, formatCode, linkStart, linkCode, linkApprove, linkFinish,
    seal2, sealMessage2, sealFile2, unwrap2, senderOk, openBody, cacheSeal, cacheOpen, store,
    signCall, verifyCall, safetyCode,
  };
})(typeof window !== "undefined" ? window : globalThis);
