/* Scraveit chat encryption (end to end).
 *
 * Each phone has its own key pair per account, made and kept by the Android app (protected by the
 * phone's Keystore); only the public half is published (chatKeys/{uid}). Two friends' phones work
 * out the same secret key for their chat from their own private key and the other's public key
 * (P-256 ECDH), stretch it with HKDF-SHA256, and lock every message, photo and voice message with
 * AES-256-GCM before it leaves the phone. Scraveit's server only ever stores and forwards the
 * locked bytes. The Android app does the same maths to show the text in notifications.
 *
 * Format (version 1), shared with ChatE2eCrypto.java:
 *   public key  = base64 of the raw uncompressed P-256 point (65 bytes, 88 characters)
 *   key id      = first 16 hex characters of SHA-256(raw public key)
 *   chat key    = HKDF-SHA256(ECDH x-coordinate, salt "scraveit-chat-v1|" + pairId, info "chat", 32 bytes)
 *   sealed      = {v: 1, iv: base64 12 bytes, ct: base64 ciphertext+tag, spk: sender public key, rpk: recipient public key}
 *   bound to    = additional data "m|pairId|from|messageId" (messages), "p|…|photoId" (photos), "v|…|voiceId" (voice)
 *   message     = UTF-8 JSON {t: text, c: card or null}
 *   photo/voice = UTF-8 mime type, a newline, then the file's bytes
 *
 * Calls: each phone signs the call's DTLS fingerprints with its own signing key (ECDSA P-256), so the
 * server can't sit in the middle of a call without the other phone noticing.
 */
(function (root) {
  "use strict";
  const subtle = root.crypto && root.crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();

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
  const isPub = (k) => typeof k === "string" && k.length === 88 && /^[A-Za-z0-9+/]+=*$/.test(k);

  async function kidOf(pub) { return hex(await subtle.digest("SHA-256", unb64(pub))).slice(0, 16); }

  /**
   * This phone's keys for one account, as the Android app hands them over: base64 PKCS#8 private
   * keys and raw public keys. Private keys are imported as non-extractable.
   */
  async function importOwn(k) {
    if (!k || !isPub(k.agreePub) || !isPub(k.signPub)) throw new Error("E2E_KEYS_INVALID");
    const agree = await subtle.importKey("pkcs8", unb64(k.agreePriv), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const sign = await subtle.importKey("pkcs8", unb64(k.signPriv), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return { agree, sign, agreePub: k.agreePub, signPub: k.signPub, kid: await kidOf(k.agreePub) };
  }

  // One AES key per (my key, their key, chat), worked out once.
  const chatKeys = new Map();
  async function chatKey(own, theirPub, pairId) {
    if (!isPub(theirPub)) throw new Error("E2E_PEER_KEY_INVALID");
    const id = own.agreePub + "|" + theirPub + "|" + pairId;
    if (chatKeys.has(id)) return chatKeys.get(id);
    const p = (async () => {
      const peer = await subtle.importKey("raw", unb64(theirPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = await subtle.deriveBits({ name: "ECDH", public: peer }, own.agree, 256);
      const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
      return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("scraveit-chat-v1|" + pairId), info: enc.encode("chat") },
        ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    })();
    chatKeys.set(id, p);
    p.catch(() => chatKeys.delete(id));
    return p;
  }

  /** Locks bytes (or text) for a chat. Returns the sealed record to store. */
  async function seal(own, theirPub, pairId, aad, data) {
    const key = await chatKey(own, theirPub, pairId), iv = root.crypto.getRandomValues(new Uint8Array(12));
    const plain = typeof data === "string" ? enc.encode(data) : data;
    const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 }, key, plain);
    return { v: 1, iv: b64(iv), ct: b64(ct), spk: own.agreePub, rpk: theirPub };
  }

  /**
   * Unlocks a sealed record with this phone's key. Throws E2E_NOT_FOR_THIS_PHONE when it was locked
   * for a different key of mine (another phone, or before a reinstall).
   */
  async function open(own, sealed, pairId, aad) {
    if (!sealed || sealed.v !== 1) throw new Error("E2E_UNKNOWN_FORMAT");
    const theirPub = sealed.spk === own.agreePub ? sealed.rpk : sealed.rpk === own.agreePub ? sealed.spk : "";
    if (!theirPub) throw new Error("E2E_NOT_FOR_THIS_PHONE");
    const key = await chatKey(own, theirPub, pairId);
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv), additionalData: enc.encode(aad), tagLength: 128 }, key, unb64(sealed.ct)));
  }

  const msgAad = (pairId, from, id) => "m|" + pairId + "|" + from + "|" + id;
  const photoAad = (pairId, from, id) => "p|" + pairId + "|" + from + "|" + id;
  const voiceAad = (pairId, from, id) => "v|" + pairId + "|" + from + "|" + id;

  async function sealMessage(own, theirPub, pairId, from, id, text, card) {
    return seal(own, theirPub, pairId, msgAad(pairId, from, id), JSON.stringify({ t: String(text || ""), c: card || null }));
  }
  async function openMessage(own, sealed, pairId, from, id) {
    const v = JSON.parse(dec.decode(await open(own, sealed, pairId, msgAad(pairId, from, id))));
    return { text: typeof v.t === "string" ? v.t : "", card: v.c && typeof v.c === "object" ? v.c : null };
  }
  /** A file (photo or voice message): its mime type travels inside the lock. */
  async function sealFile(own, theirPub, pairId, aad, mime, bytes) {
    const head = enc.encode(String(mime) + "\n"), all = new Uint8Array(head.length + bytes.length);
    all.set(head); all.set(bytes, head.length);
    return seal(own, theirPub, pairId, aad, all);
  }
  async function openFile(own, sealed, pairId, aad) {
    const all = await open(own, sealed, pairId, aad), nl = all.indexOf(10);
    if (nl < 1 || nl > 80) throw new Error("E2E_BAD_FILE");
    return { mime: dec.decode(all.subarray(0, nl)), bytes: all.subarray(nl + 1) };
  }

  // ---- calls ----
  /** What a phone signs for a call: the call, its side, and its DTLS fingerprints. */
  function callStatement(callId, side, sdp) {
    const prints = String(sdp || "").split(/\r?\n/).filter((l) => /^a=fingerprint:/i.test(l)).map((l) => l.trim().toLowerCase()).sort();
    return "scraveit-call-v1|" + callId + "|" + side + "|" + prints.join("|");
  }
  async function signCall(own, callId, side, sdp) {
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, own.sign, enc.encode(callStatement(callId, side, sdp)));
    return { k: await kidOf(own.signPub), s: b64(sig) };
  }
  async function verifyCall(signPub, sig, callId, side, sdp) {
    if (!isPub(signPub) || !sig || typeof sig.s !== "string" || !/a=fingerprint:/i.test(String(sdp || ""))) return false;
    try {
      const key = await subtle.importKey("raw", unb64(signPub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(sig.s), enc.encode(callStatement(callId, side, sdp)));
    } catch (_) { return false; }
  }

  // ---- safety code ----
  /**
   * The code two friends compare to be sure no one swapped their keys: 60 digits, the same on both
   * phones (the lower account id's half comes first), 30 from each person's keys.
   */
  async function safetyCode(uidA, keysA, uidB, keysB) {
    const half = async (uid, k) => {
      let d = new Uint8Array(await subtle.digest("SHA-256", enc.encode("scraveit-safety-v1|" + uid + "|" + k.agree + "|" + k.sign)));
      for (let i = 0; i < 1023; i++) d = new Uint8Array(await subtle.digest("SHA-256", d));
      let out = "";
      for (let i = 0; i < 30; i += 5) {
        const n = ((d[i] * 2 ** 32) + ((d[i + 1] << 24) >>> 0) + (d[i + 2] << 16) + (d[i + 3] << 8) + d[i + 4]) % 100000;
        out += String(n).padStart(5, "0");
      }
      return out;
    };
    const [first, second] = uidA < uidB ? [[uidA, keysA], [uidB, keysB]] : [[uidB, keysB], [uidA, keysA]];
    return (await half(first[0], first[1])) + (await half(second[0], second[1]));
  }

  root.ScraveitE2E = {
    available: !!(subtle && root.TextEncoder),
    b64, unb64, isPub, kidOf, importOwn, sealMessage, openMessage, sealFile, openFile, photoAad, voiceAad,
    signCall, verifyCall, safetyCode,
  };
})(typeof window !== "undefined" ? window : globalThis);
