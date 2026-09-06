package com.feastly.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Keeps delivery OTPs encrypted with an Android Keystore key instead of WebView storage. */
final class SecureOrderStore {
  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "savrivo_customer_delivery_otp_v1";
  private static final String PREFS = "savrivo_customer_secure_orders_v1";
  private static final String TRANSFORMATION = "AES/GCM/NoPadding";

  private final SharedPreferences preferences;

  SecureOrderStore(Context context) {
    preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  synchronized void putDeliveryOtp(String orderId, String otp) throws Exception {
    if (!validOrderId(orderId) || otp == null || !otp.matches("\\d{4,6}")) return;
    Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.ENCRYPT_MODE, key());
    byte[] encrypted = cipher.doFinal(otp.getBytes(StandardCharsets.UTF_8));
    byte[] iv = cipher.getIV();
    byte[] packed = new byte[1 + iv.length + encrypted.length];
    packed[0] = (byte) iv.length;
    System.arraycopy(iv, 0, packed, 1, iv.length);
    System.arraycopy(encrypted, 0, packed, 1 + iv.length, encrypted.length);
    preferences.edit().putString(orderId, Base64.encodeToString(packed, Base64.NO_WRAP)).apply();
  }

  synchronized String getDeliveryOtp(String orderId) throws Exception {
    if (!validOrderId(orderId)) return "";
    String encoded = preferences.getString(orderId, "");
    if (encoded == null || encoded.length() == 0) return "";
    byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
    int ivLength = packed.length == 0 ? 0 : packed[0] & 0xff;
    if (ivLength < 12 || packed.length <= 1 + ivLength) return "";
    byte[] iv = new byte[ivLength];
    byte[] encrypted = new byte[packed.length - 1 - ivLength];
    System.arraycopy(packed, 1, iv, 0, ivLength);
    System.arraycopy(packed, 1 + ivLength, encrypted, 0, encrypted.length);
    Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
    return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
  }

  synchronized void removeDeliveryOtp(String orderId) {
    if (validOrderId(orderId)) preferences.edit().remove(orderId).apply();
  }

  synchronized void clear() {
    preferences.edit().clear().apply();
  }

  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance(KEYSTORE);
    store.load(null);
    java.security.Key existing = store.getKey(KEY_ALIAS, null);
    if (existing instanceof SecretKey) return (SecretKey) existing;
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
    generator.init(new KeyGenParameterSpec.Builder(
        KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true)
        .build());
    return generator.generateKey();
  }

  private boolean validOrderId(String value) {
    return value != null && value.matches("[A-Za-z0-9_.:-]{1,120}");
  }
}
