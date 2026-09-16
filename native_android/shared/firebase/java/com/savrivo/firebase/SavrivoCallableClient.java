package com.savrivo.firebase;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Uses the official callable HTTPS wire format while retaining the web-authenticated session. */
public final class SavrivoCallableClient {
    private static final String TAG = "SavrivoCallable";
    public interface Callback {
        void complete(boolean success, String json);
    }

    private static final Set<String> FUNCTIONS = new HashSet<>(Arrays.asList(
            "registerPushToken", "unregisterPushToken", "updateOrderStatus", "claimRiderOrder",
            "declineRiderOrder", "markRiderArrivedRestaurant", "getAdminDashboard",
            "recordCodRemittance", "recordRiderPayout", "recordRestaurantSettlement",
            "getRiderFinancialSummary", "getRiderRewardsDashboard",
            "getAdminRiderRewardsDashboard", "upsertRiderRewardCampaignPolicy",
            "updateRiderRewardSettingsPolicy", "getRestaurantSettlementSummary",
            "getPlatformConfiguration", "updatePlatformConfigurationPolicy",
            "exportPlatformDataWorkbook"));
    private static final ExecutorService NETWORK = Executors.newFixedThreadPool(3);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final int MAX_RESPONSE_BYTES = 256 * 1024;

    private SavrivoCallableClient() { }

    public static void registerPushToken(Context context, String idToken, Callback callback) {
        FirebaseApp app = SavrivoFirebase.ensureInitialized(context);
        if (app == null) {
            fail(callback, SavrivoFirebase.configurationError(context));
            return;
        }
        FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(token -> {
                    if (token == null || token.length() < 20) {
                        fail(callback, "FCM_TOKEN_UNAVAILABLE");
                        return;
                    }
                    JSONObject data = new JSONObject();
                    try {
                        data.put("token", token);
                        data.put("app", SavrivoFirebase.appRole(context));
                        data.put("platform", "android");
                        data.put("appVersion", versionName(context));
                        data.put("deviceModel", truncate(Build.MANUFACTURER + " " + Build.MODEL, 120));
                    } catch (Exception error) {
                        fail(callback, "PUSH_REGISTRATION_PAYLOAD_FAILED");
                        return;
                    }
                    call(context, "registerPushToken", idToken, data, callback);
                })
                .addOnFailureListener(error -> fail(callback, "FCM_TOKEN_UNAVAILABLE"));
    }

    public static void unregisterPushToken(Context context, String idToken, Callback callback) {
        FirebaseApp app = SavrivoFirebase.ensureInitialized(context);
        if (app == null) {
            fail(callback, SavrivoFirebase.configurationError(context));
            return;
        }
        FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(token -> {
                    if (token == null || token.length() < 20) {
                        callback.complete(true, "{\"removed\":false}");
                        return;
                    }
                    JSONObject data = new JSONObject();
                    try { data.put("token", token); }
                    catch (Exception ignored) { }
                    call(context, "unregisterPushToken", idToken, data, (success, json) -> {
                        if (success) FirebaseMessaging.getInstance().deleteToken();
                        callback.complete(success, json);
                    });
                })
                .addOnFailureListener(error -> fail(callback, "FCM_TOKEN_UNAVAILABLE"));
    }

    public static void updateOrderStatus(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "updateOrderStatus", idToken, payload, callback);
    }

    public static void getAdminDashboard(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "getAdminDashboard", idToken, payload, callback);
    }

    public static void recordCodRemittance(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "recordCodRemittance", idToken, payload, callback);
    }

    public static void recordRiderPayout(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "recordRiderPayout", idToken, payload, callback);
    }

    public static void recordRestaurantSettlement(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "recordRestaurantSettlement", idToken, payload, callback);
    }

    public static void getRiderFinancialSummary(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "getRiderFinancialSummary", idToken, payload, callback);
    }

    public static void getRiderRewardsDashboard(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "getRiderRewardsDashboard", idToken, payload, callback);
    }

    public static void getAdminRiderRewardsDashboard(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "getAdminRiderRewardsDashboard", idToken, payload, callback);
    }

    public static void upsertRiderRewardCampaignPolicy(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "upsertRiderRewardCampaignPolicy", idToken, payload, callback);
    }

    public static void updateRiderRewardSettingsPolicy(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "updateRiderRewardSettingsPolicy", idToken, payload, callback);
    }

    public static void getPlatformConfiguration(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "getPlatformConfiguration", idToken, payload, callback);
    }

    public static void exportPlatformDataWorkbook(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "exportPlatformDataWorkbook", idToken, payload, callback);
    }

    public static void updatePlatformConfigurationPolicy(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "updatePlatformConfigurationPolicy", idToken, payload, callback);
    }

    public static void getRestaurantSettlementSummary(
            Context context, String idToken, JSONObject payload, Callback callback) {
        call(context, "getRestaurantSettlementSummary", idToken, payload, callback);
    }

    public static void claimRiderOrder(
            Context context, String idToken, String orderId, Callback callback) {
        riderOrderAction(context, "claimRiderOrder", idToken, orderId, callback);
    }

    public static void declineRiderOrder(
            Context context, String idToken, String orderId, Callback callback) {
        riderOrderAction(context, "declineRiderOrder", idToken, orderId, callback);
    }

    public static void markRiderArrivedRestaurant(
            Context context, String idToken, String orderId, Callback callback) {
        riderOrderAction(context, "markRiderArrivedRestaurant", idToken, orderId, callback);
    }

    private static void riderOrderAction(
            Context context, String function, String idToken, String orderId, Callback callback) {
        if (orderId == null || !orderId.matches("[A-Za-z0-9_.:-]{1,120}")) {
            fail(callback, "INVALID_ORDER_ID");
            return;
        }
        JSONObject payload = new JSONObject();
        try { payload.put("orderId", orderId); }
        catch (Exception ignored) { }
        call(context, function, idToken, payload, callback);
    }

    private static void call(
            Context context, String function, String idToken, JSONObject data, Callback callback) {
        if (!FUNCTIONS.contains(function)) {
            fail(callback, "FUNCTION_NOT_ALLOWED");
            return;
        }
        if (!validToken(idToken)) {
            fail(callback, "AUTH_REQUIRED");
            return;
        }
        if (data == null || data.toString().length() > 64_000) {
            fail(callback, "INVALID_PAYLOAD");
            return;
        }
        FirebaseApp app = SavrivoFirebase.ensureInitialized(context);
        if (app == null) {
            fail(callback, SavrivoFirebase.configurationError(context));
            return;
        }
        requestAppCheckAndPerform(context, app, function, idToken, data, callback, false, true);
    }

    /**
     * App Check tokens can remain cached briefly after a debug device or Play certificate is
     * registered. Critical operations get one forced refresh before failing, while still
     * requiring a valid App Check token on every request.
     */
    private static void requestAppCheckAndPerform(
            Context context, FirebaseApp app, String function, String idToken,
            JSONObject data, Callback callback, boolean forceRefresh, boolean mayRetry) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            MAIN.post(() -> requestAppCheckAndPerform(context, app, function, idToken, data,
                    callback, forceRefresh, mayRetry));
            return;
        }
        try {
            FirebaseAppCheck.getInstance(app).getAppCheckToken(forceRefresh)
                    .addOnSuccessListener(result -> {
                        String appCheck = result == null ? "" : result.getToken();
                        if (appCheck == null || appCheck.length() < 20) {
                            if (mayRetry && !forceRefresh) {
                                requestAppCheckAndPerform(context, app, function, idToken, data,
                                        callback, true, false);
                            } else {
                                fail(callback, "APP_CHECK_TOKEN_UNAVAILABLE");
                            }
                            return;
                        }
                        NETWORK.execute(() -> perform(context, app, function, idToken, appCheck,
                                data, callback, mayRetry));
                    })
                    .addOnFailureListener(error -> {
                        if (mayRetry && !forceRefresh) {
                            requestAppCheckAndPerform(context, app, function, idToken, data,
                                    callback, true, false);
                        } else {
                            Log.w(TAG, "App Check token request failed for " + function, error);
                            fail(callback, "APP_CHECK_TOKEN_UNAVAILABLE");
                        }
                    });
        } catch (Throwable error) {
            Log.e(TAG, "App Check SDK could not start for " + function, error);
            fail(callback, "APP_CHECK_NATIVE_UNAVAILABLE");
        }
    }

    private static void perform(
            Context context, FirebaseApp app, String function, String idToken, String appCheck,
            JSONObject data, Callback callback, boolean mayRetryAppCheck) {
        HttpURLConnection connection = null;
        try {
            String project = SavrivoFirebase.projectId(context);
            String region = SavrivoFirebase.functionsRegion(context);
            if (!project.matches("[a-z0-9-]{3,80}")) throw new IllegalStateException("PROJECT_ID_MISSING");
            URL url = new URL("https://" + region + "-" + project
                    + ".cloudfunctions.net/" + function);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + idToken);
            connection.setRequestProperty("X-Firebase-AppCheck", appCheck);
            connection.setRequestProperty("X-Client-Version",
                    "savrivo-android/" + truncate(versionName(context), 40));
            JSONObject envelope = new JSONObject().put("data", data);
            byte[] body = envelope.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (java.io.OutputStream output = connection.getOutputStream()) {
                output.write(body);
                output.flush();
            }

            int status = connection.getResponseCode();
            if ((status == HttpURLConnection.HTTP_UNAUTHORIZED
                    || status == HttpURLConnection.HTTP_FORBIDDEN) && mayRetryAppCheck) {
                requestAppCheckAndPerform(context, app, function, idToken, data, callback,
                        true, false);
                return;
            }
            InputStream stream = status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream();
            String responseBody = readLimited(stream);
            if (!looksLikeJson(responseBody)) {
                fail(callback, "FUNCTION_HTTP_" + status);
                return;
            }
            JSONObject response = responseBody.isEmpty() ? new JSONObject() : new JSONObject(responseBody);
            if (status >= 200 && status < 300 && (response.has("result") || response.has("data"))) {
                Object result = response.has("result") ? response.get("result") : response.get("data");
                callback.complete(true, jsonValue(result));
                return;
            }
            JSONObject error = response.optJSONObject("error");
            String message = error == null ? "FUNCTION_HTTP_" + status
                    : error.optString("message", error.optString("status", "FUNCTION_REJECTED"));
            fail(callback, message);
        } catch (Exception error) {
            fail(callback, truncate(error.getMessage() == null ? "FUNCTION_NETWORK_ERROR" : error.getMessage(), 300));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readLimited(InputStream stream) throws Exception {
        if (stream == null) return "";
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8_192];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) >= 0) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("FUNCTION_RESPONSE_TOO_LARGE");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static boolean looksLikeJson(String value) {
        String body = value == null ? "" : value.trim();
        return body.isEmpty() || body.startsWith("{") || body.startsWith("[");
    }

    private static String jsonValue(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject || value instanceof org.json.JSONArray) return value.toString();
        if (value instanceof Number || value instanceof Boolean) return String.valueOf(value);
        return JSONObject.quote(String.valueOf(value));
    }

    private static boolean validToken(String token) {
        return token != null && token.length() >= 32 && token.length() <= 16_384
                && token.matches("[A-Za-z0-9._~-]+");
    }

    private static String versionName(Context context) {
        try {
            return String.valueOf(context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).versionName);
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String truncate(String value, int max) {
        String safe = value == null ? "" : value;
        return safe.length() <= max ? safe : safe.substring(0, max);
    }

    private static void fail(Callback callback, String message) {
        String safe = truncate(message == null ? "UNKNOWN_ERROR" : message, 500);
        callback.complete(false, "{\"error\":{\"message\":" + JSONObject.quote(safe) + "}}");
    }
}
