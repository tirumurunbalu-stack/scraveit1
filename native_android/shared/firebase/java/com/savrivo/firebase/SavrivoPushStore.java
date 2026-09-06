package com.savrivo.firebase;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

public final class SavrivoPushStore {
    public static final String ACTION_PUSH = "com.savrivo.firebase.PUSH_EVENT";
    public static final String EXTRA_EVENT = "savrivo_push_event";
    private static final String PREFS = "savrivo.native.push.events";
    private static final String KEY_QUEUE = "queue";
    private static final int MAX_EVENTS = 50;
    private static final Object LOCK = new Object();

    private SavrivoPushStore() { }

    public static void dispatch(Context context, JSONObject event) {
        if (event == null) return;
        synchronized (LOCK) {
            JSONArray current = read(context);
            JSONArray next = new JSONArray();
            int start = Math.max(0, current.length() - (MAX_EVENTS - 1));
            for (int index = start; index < current.length(); index++) {
                JSONObject value = current.optJSONObject(index);
                if (value != null) next.put(value);
            }
            next.put(event);
            preferences(context).edit().putString(KEY_QUEUE, next.toString()).apply();
        }
        Intent broadcast = new Intent(ACTION_PUSH).setPackage(context.getPackageName());
        context.sendBroadcast(broadcast);
    }

    public static String takePending(Context context) {
        synchronized (LOCK) {
            JSONArray events = read(context);
            preferences(context).edit().remove(KEY_QUEUE).apply();
            return events.toString();
        }
    }

    public static void removeRiderOffer(Context context, String orderId) {
        removeEvent(context, "RIDER_ORDER_OFFER", orderId);
    }

    public static void removeRestaurantNewOrder(Context context, String orderId) {
        removeEvent(context, "RESTAURANT_NEW_ORDER", orderId);
    }

    private static void removeEvent(Context context, String eventType, String orderId) {
        synchronized (LOCK) {
            JSONArray current = read(context);
            JSONArray next = new JSONArray();
            for (int index = 0; index < current.length(); index++) {
                JSONObject value = current.optJSONObject(index);
                if (value == null) continue;
                boolean matchingOffer = eventType.equals(value.optString("type"))
                        && orderId.equals(value.optString("orderId"));
                if (!matchingOffer) next.put(value);
            }
            preferences(context).edit().putString(KEY_QUEUE, next.toString()).apply();
        }
    }

    public static JSONObject eventFromIntent(Intent intent) {
        if (intent == null) return null;
        String raw = intent.getStringExtra(EXTRA_EVENT);
        if (raw == null || raw.length() == 0 || raw.length() > 32_000) return null;
        try { return new JSONObject(raw); }
        catch (Exception ignored) { return null; }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONArray read(Context context) {
        String raw = preferences(context).getString(KEY_QUEUE, "[]");
        try { return new JSONArray(raw == null ? "[]" : raw); }
        catch (Exception ignored) { return new JSONArray(); }
    }
}
