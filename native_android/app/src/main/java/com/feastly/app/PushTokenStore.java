package com.feastly.app;

import android.content.Context;
import android.content.SharedPreferences;

/** App-private lifecycle state for the current FCM installation token. */
final class PushTokenStore {
  private static final String PREFS = "savrivo_customer_push_v1";
  private static final String KEY_TOKEN = "token";

  private PushTokenStore() { }

  static void save(Context context, String token) {
    if (token == null || token.trim().length() < 20) return;
    preferences(context).edit().putString(KEY_TOKEN, token.trim()).apply();
  }

  static String read(Context context) {
    return preferences(context).getString(KEY_TOKEN, "");
  }

  static void clear(Context context, String token) {
    String current = read(context);
    if (token == null || token.equals(current)) preferences(context).edit().remove(KEY_TOKEN).apply();
  }

  private static SharedPreferences preferences(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }
}
