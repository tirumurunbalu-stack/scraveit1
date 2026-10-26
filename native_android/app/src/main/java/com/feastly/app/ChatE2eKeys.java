package com.feastly.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * This phone's chat encryption keys, one set per account: a P-256 key for working out each chat's
 * key and one for signing calls. Made the first time chat opens and kept on this phone only,
 * encrypted with an Android Keystore key (so a copied app backup can't use them). The page gets
 * them to lock and unlock messages; the push service uses them to show messages in notifications.
 */
final class ChatE2eKeys {
  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String WRAP_ALIAS = "scraveit_chat_e2e_wrap_v1";
  private static final String PREFS = "scraveit_chat_e2e_v1";

  private ChatE2eKeys() { }

  static boolean validUid(String uid) {
    return uid != null && uid.matches("[A-Za-z0-9]{10,128}");
  }

  /** {agreePriv, agreePub, signPriv, signPub} for this account, made on first use. */
  static synchronized JSONObject keysFor(Context context, String uid) throws Exception {
    JSONObject existing = stored(context, uid);
    if (existing != null) return existing;
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    KeyPair agree = generator.generateKeyPair();
    KeyPair sign = generator.generateKeyPair();
    JSONObject keys = new JSONObject();
    keys.put("agreePriv", ChatE2eCrypto.b64encode(agree.getPrivate().getEncoded()));
    keys.put("agreePub", ChatE2eCrypto.rawFromPublic(agree.getPublic()));
    keys.put("signPriv", ChatE2eCrypto.b64encode(sign.getPrivate().getEncoded()));
    keys.put("signPub", ChatE2eCrypto.rawFromPublic(sign.getPublic()));
    prefs(context).edit().putString(uid, wrap(keys.toString().getBytes(StandardCharsets.UTF_8))).commit();
    return keys;
  }

  /** This account's private key for working out chat keys, if its public key is rawPub. */
  static synchronized PrivateKey agreeKeyFor(Context context, String uid, String rawPub) throws Exception {
    JSONObject keys = stored(context, uid);
    if (keys == null || rawPub == null || !rawPub.equals(keys.optString("agreePub", ""))) return null;
    return KeyFactory.getInstance("EC").generatePrivate(
        new PKCS8EncodedKeySpec(ChatE2eCrypto.b64decode(keys.getString("agreePriv"))));
  }

  private static JSONObject stored(Context context, String uid) {
    if (!validUid(uid)) return null;
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
