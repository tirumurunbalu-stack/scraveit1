package com.feastly.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.spec.PKCS8EncodedKeySpec;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Chat encryption keys on this phone, kept encrypted with an Android Keystore key (so a copied app
 * backup can't use them). Version 2: the account's shared key set, made and synced by the page
 * (chat-e2e.js) and stored here; version 1: the first release's per-phone keys, kept to read old
 * messages. The push service uses them to show messages in notifications.
 */
final class ChatE2eKeys {
  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String WRAP_ALIAS = "scraveit_chat_e2e_wrap_v1";
  private static final String PREFS = "scraveit_chat_e2e_v1";

  private ChatE2eKeys() { }

  static boolean validUid(String uid) {
    return uid != null && uid.matches("[A-Za-z0-9]{10,128}");
  }

  /** The first release's per-phone keys for this account, if this phone made some (old messages). */
  static synchronized JSONObject v1Keys(Context context, String uid) {
    return stored(context, uid);
  }

  /** The first release's private key for working out chat keys, if its public key is rawPub. */
  static synchronized PrivateKey agreeKeyFor(Context context, String uid, String rawPub) throws Exception {
    JSONObject keys = stored(context, uid);
    if (keys == null || rawPub == null || !rawPub.equals(keys.optString("agreePub", ""))) return null;
    return KeyFactory.getInstance("EC").generatePrivate(
        new PKCS8EncodedKeySpec(ChatE2eCrypto.b64decode(keys.getString("agreePriv"))));
  }

  /**
   * The account's shared key set on this phone (version 2), as the page keeps it:
   * {v: 2, uid, id, avk, cache, epochs: {n: {priv, pub, at, sig, until?}}, pendingCode?}.
   */
  static synchronized JSONObject v2Bundle(Context context, String uid) {
    return stored(context, "v2_" + uid);
  }

  static synchronized void putV2Bundle(Context context, String uid, JSONObject bundle) throws Exception {
    if (!validUid(uid) || bundle == null || bundle.optInt("v", 0) != 2 || !uid.equals(bundle.optString("uid", ""))) {
      throw new IllegalArgumentException("E2E_BUNDLE_INVALID");
    }
    byte[] plain = bundle.toString().getBytes(StandardCharsets.UTF_8);
    if (plain.length > 256 * 1024) throw new IllegalArgumentException("E2E_BUNDLE_TOO_LARGE");
    prefs(context).edit().putString("v2_" + uid, wrap(plain)).commit();
  }

  /** Forgets the account's key set on this phone (signed out of chat by another phone, or starting over). */
  static synchronized void forgetV2Bundle(Context context, String uid) {
    if (validUid(uid)) prefs(context).edit().remove("v2_" + uid).commit();
  }

  /** This account's chat keys on this phone, each by its key id, for unlocking notifications. */
  static synchronized java.util.Map<String, Object[]> v2EpochKeys(Context context, String uid) throws Exception {
    java.util.Map<String, Object[]> out = new java.util.HashMap<>();
    JSONObject bundle = v2Bundle(context, uid);
    JSONObject epochs = bundle == null ? null : bundle.optJSONObject("epochs");
    if (epochs == null) return out;
    long now = System.currentTimeMillis();
    java.util.Iterator<String> names = epochs.keys();
    while (names.hasNext()) {
      JSONObject epoch = epochs.getJSONObject(names.next());
      if (epoch.has("until") && epoch.optLong("until", 0) < now) continue;
      String pub = epoch.getString("pub");
      PrivateKey priv = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(ChatE2eCrypto.b64decode(epoch.getString("priv"))));
      out.put(ChatE2eCrypto.keyId(pub), new Object[]{priv, pub});
    }
    return out;
  }

  private static JSONObject stored(Context context, String uid) {
    if (!validUid(uid.startsWith("v2_") ? uid.substring(3) : uid)) return null;
    String packed = prefs(context).getString(uid, "");
    if (packed == null || packed.isEmpty()) return null;
    try {
      return new JSONObject(new String(unwrap(packed), StandardCharsets.UTF_8));
    } catch (Exception lost) {
      // The Keystore key is gone (restored from a backup on another phone): start again.
      return null;
    }
  }

  private static SharedPreferences prefs(Context context) {
    return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static String wrap(byte[] plain) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, wrapKey());
    byte[] iv = cipher.getIV();
    byte[] sealed = cipher.doFinal(plain);
    byte[] packed = new byte[1 + iv.length + sealed.length];
    packed[0] = (byte) iv.length;
    System.arraycopy(iv, 0, packed, 1, iv.length);
    System.arraycopy(sealed, 0, packed, 1 + iv.length, sealed.length);
    return ChatE2eCrypto.b64encode(packed);
  }

  private static byte[] unwrap(String text) throws Exception {
    byte[] packed = ChatE2eCrypto.b64decode(text);
    int ivLength = packed.length == 0 ? 0 : packed[0] & 0xff;
    if (ivLength < 12 || packed.length <= 1 + ivLength) throw new IllegalStateException("E2E_STORE_BROKEN");
    byte[] iv = new byte[ivLength];
    byte[] sealed = new byte[packed.length - 1 - ivLength];
    System.arraycopy(packed, 1, iv, 0, ivLength);
    System.arraycopy(packed, 1 + ivLength, sealed, 0, sealed.length);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, iv));
    return cipher.doFinal(sealed);
  }

  private static SecretKey wrapKey() throws Exception {
    KeyStore store = KeyStore.getInstance(KEYSTORE);
    store.load(null);
    java.security.Key existing = store.getKey(WRAP_ALIAS, null);
    if (existing instanceof SecretKey) return (SecretKey) existing;
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
    generator.init(new KeyGenParameterSpec.Builder(
        WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build());
    return generator.generateKey();
  }
}
