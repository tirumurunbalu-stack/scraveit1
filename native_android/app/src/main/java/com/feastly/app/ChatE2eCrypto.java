package com.feastly.app;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The maths behind chat encryption, the same as assets/chat-e2e.js (versions 1 and 2): P-256 ECDH,
 * HKDF-SHA256 and AES-256-GCM. Plain Java, so it runs in the push service without the WebView.
 */
final class ChatE2eCrypto {
  private ChatE2eCrypto() { }

  // An X.509 SubjectPublicKeyInfo header for an uncompressed P-256 point; the 65 point bytes follow.
  private static final byte[] P256_SPKI_HEADER = hexBytes("3059301306072a8648ce3d020106082a8648ce3d030107034200");

  static PublicKey publicFromRaw(String base64) throws Exception {
    byte[] raw = b64decode(base64);
    if (raw.length != 65 || raw[0] != 4) throw new IllegalArgumentException("E2E_PEER_KEY_INVALID");
    byte[] der = Arrays.copyOf(P256_SPKI_HEADER, P256_SPKI_HEADER.length + 65);
    System.arraycopy(raw, 0, der, P256_SPKI_HEADER.length, 65);
    return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
  }

  /** Base64 of the raw uncompressed point: the last 65 bytes of the key's X.509 encoding. */
  static String rawFromPublic(PublicKey key) {
    byte[] der = key.getEncoded();
    return b64encode(Arrays.copyOfRange(der, der.length - 65, der.length));
  }

  static byte[] chatKey(PrivateKey mine, String theirPub, String pairId) throws Exception {
    return hkdf(ecdh(mine, theirPub), "scraveit-chat-v1|" + pairId, "chat");
  }

  /**
   * Version 2: the message's own key (CEK) is wrapped for this account's chat key myPub with
   * HKDF(ECDH(mine, epk) || ECDH(mine, spk)); unwrap it, then unlock the message with it.
   */
  static byte[] openV2(PrivateKey mine, String myPub, String pairId, String aad, String epk, String spk,
                       String wrapIv, String wrapC, String iv, String ct) throws Exception {
    byte[] a = ecdh(mine, epk);
    byte[] b = ecdh(mine, spk);
    byte[] both = Arrays.copyOf(a, a.length + b.length);
    System.arraycopy(b, 0, both, a.length, b.length);
    byte[] wrapKey = hkdf(both, "scraveit-chat-v2|" + pairId, "wrap|" + epk + "|" + spk + "|" + myPub);
    byte[] cek = open(wrapKey, wrapIv, wrapC, aad);
    return open(cek, iv, ct, aad);
  }

  private static byte[] ecdh(PrivateKey mine, String theirPub) throws Exception {
    KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
    agreement.init(mine);
    agreement.doPhase(publicFromRaw(theirPub), true);
    return agreement.generateSecret();
  }

  /** HKDF-SHA256 for one 32-byte block: extract with the salt, expand with the info and counter 1. */
  private static byte[] hkdf(byte[] ikm, String salt, String info) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(salt.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    byte[] prk = mac.doFinal(ikm);
    mac.init(new SecretKeySpec(prk, "HmacSHA256"));
    mac.update(info.getBytes(StandardCharsets.UTF_8));
    mac.update((byte) 1);
    return mac.doFinal();
  }

  /** Unlocks a sealed record's ciphertext; throws if it was changed or locked with another key. */
  static byte[] open(byte[] key, String ivBase64, String ctBase64, String aad) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
        new GCMParameterSpec(128, b64decode(ivBase64)));
    cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
    return cipher.doFinal(b64decode(ctBase64));
  }

  static String messageAad(String pairId, String from, String messageId) {
    return "m|" + pairId + "|" + from + "|" + messageId;
  }

  static String keyId(String rawBase64) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(b64decode(rawBase64));
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < 8; i++) out.append(String.format("%02x", digest[i]));
    return out.toString();
  }

  private static final String B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // Standard base64 with padding (java.util.Base64 needs Android 8; this app supports Android 7).
  static String b64encode(byte[] data) {
    StringBuilder out = new StringBuilder((data.length + 2) / 3 * 4);
    for (int i = 0; i < data.length; i += 3) {
      int n = (data[i] & 0xff) << 16 | (i + 1 < data.length ? (data[i + 1] & 0xff) << 8 : 0) | (i + 2 < data.length ? data[i + 2] & 0xff : 0);
      out.append(B64.charAt(n >> 18 & 63)).append(B64.charAt(n >> 12 & 63))
          .append(i + 1 < data.length ? B64.charAt(n >> 6 & 63) : '=').append(i + 2 < data.length ? B64.charAt(n & 63) : '=');
    }
    return out.toString();
  }

  static byte[] b64decode(String text) {
    String s = text == null ? "" : text.trim();
    if (s.length() % 4 != 0) throw new IllegalArgumentException("E2E_BAD_BASE64");
    int pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
    byte[] out = new byte[s.length() / 4 * 3 - pad];
    for (int i = 0, o = 0; i < s.length(); i += 4) {
      int n = 0;
      for (int j = 0; j < 4; j++) {
        char c = s.charAt(i + j);
        int v = c == '=' ? 0 : B64.indexOf(c);
        if (v < 0) throw new IllegalArgumentException("E2E_BAD_BASE64");
        n = n << 6 | v;
      }
      if (o < out.length) out[o++] = (byte) (n >> 16);
      if (o < out.length) out[o++] = (byte) (n >> 8);
      if (o < out.length) out[o++] = (byte) n;
    }
    return out;
  }

  private static byte[] hexBytes(String hex) {
    byte[] out = new byte[hex.length() / 2];
    for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    return out;
  }
}
