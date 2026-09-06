package com.feastly.app;

import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.crashlytics.FirebaseCrashlytics;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

/**
 * Small, authenticated implementation of the Firebase callable wire protocol.
 *
 * The signed-in session currently belongs to the packaged Customer web layer,
 * so its short-lived Firebase ID token is supplied explicitly. Native App Check
 * is acquired here and neither credential is written to disk or logs.
 */
final class FirebaseCallableClient {
  interface Callback {
    void onSuccess(JSONObject data);
    void onFailure(String code, String message);
  }

  private static final String REGION = "asia-south1";
  private static final int MAX_REQUEST_BYTES = 96 * 1024;
  private static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  private final ExecutorService networkExecutor = Executors.newFixedThreadPool(2);

  void call(String functionName, String firebaseIdToken, JSONObject payload, Callback callback) {
    if (!allowedFunction(functionName)) {
      callback.onFailure("INVALID_OPERATION", "This operation is not available.");
      return;
    }
    if (firebaseIdToken == null || firebaseIdToken.length() < 100 || firebaseIdToken.length() > 8192) {
      callback.onFailure("AUTH_REQUIRED", "Please sign in again to continue.");
      return;
    }
    byte[] requestBytes = callableBody(payload).getBytes(StandardCharsets.UTF_8);
    if (requestBytes.length > MAX_REQUEST_BYTES) {
      callback.onFailure("INVALID_ARGUMENT", "The request is too large.");
      return;
    }

    FirebaseAppCheck.getInstance().getAppCheckToken(false)
        .addOnSuccessListener(tokenResult -> networkExecutor.execute(() -> execute(
            functionName, firebaseIdToken, tokenResult.getToken(), requestBytes, callback)))
        .addOnFailureListener(error -> {
          FirebaseCrashlytics.getInstance().recordException(error);
          callback.onFailure("APP_CHECK_UNAVAILABLE",
              "This installation could not be verified. Update Scraveit from Google Play and try again.");
        });
  }

  void close() {
    networkExecutor.shutdownNow();
  }

  private void execute(String functionName, String firebaseIdToken, String appCheckToken,
                       byte[] requestBytes, Callback callback) {
    HttpsURLConnection connection = null;
    try {
      String projectId = FirebaseApp.getInstance().getOptions().getProjectId();
      if (projectId == null || !projectId.matches("[a-z0-9-]{4,80}")) {
        callback.onFailure("CONFIGURATION_MISSING", "Firebase is not configured for this build.");
        return;
      }
      URL endpoint = new URL("https://" + REGION + "-" + projectId
          + ".cloudfunctions.net/" + functionName);
      connection = (HttpsURLConnection) endpoint.openConnection();
      connection.setRequestMethod("POST");
      connection.setConnectTimeout(12_000);
      connection.setReadTimeout(32_000);
      connection.setDoOutput(true);
      connection.setUseCaches(false);
      connection.setInstanceFollowRedirects(false);
      connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      connection.setRequestProperty("Accept", "application/json");
      connection.setRequestProperty("Authorization", "Bearer " + firebaseIdToken);
      connection.setRequestProperty("X-Firebase-AppCheck", appCheckToken);
      connection.setFixedLengthStreamingMode(requestBytes.length);
      try (OutputStream output = connection.getOutputStream()) {
        output.write(requestBytes);
      }

      int status = connection.getResponseCode();
      InputStream stream = status >= 200 && status < 300
          ? connection.getInputStream() : connection.getErrorStream();
      String responseText = readLimited(stream);
      JSONObject response = responseText.length() == 0 ? new JSONObject() : new JSONObject(responseText);
      if (status >= 200 && status < 300 && !response.has("error")) {
        Object result = response.has("result") ? response.opt("result") : response.opt("data");
        callback.onSuccess(result instanceof JSONObject ? (JSONObject) result : new JSONObject());
        return;
      }

      JSONObject error = response.optJSONObject("error");
      String code = error == null ? "FUNCTION_UNAVAILABLE"
          : normalizeCode(error.optString("status", "FUNCTION_FAILED"));
      String message = error == null ? "The ordering service is temporarily unavailable."
          : error.optString("message", "The request could not be completed.");
      callback.onFailure(code, message);
    } catch (java.net.SocketTimeoutException error) {
      callback.onFailure("REQUEST_TIMEOUT", "The request timed out. Please retry; your order will not be duplicated.");
    } catch (Exception error) {
      FirebaseCrashlytics.getInstance().recordException(error);
      callback.onFailure("NETWORK_REQUEST_FAILED", "Could not reach Scraveit securely. Check your connection and try again.");
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private String callableBody(JSONObject payload) {
    JSONObject body = new JSONObject();
    try { body.put("data", payload == null ? new JSONObject() : payload); }
    catch (Exception ignored) { }
    return body.toString();
  }

  private String readLimited(InputStream input) throws Exception {
    if (input == null) return "";
    try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int total = 0;
      int count;
      while ((count = stream.read(buffer)) != -1) {
        total += count;
        if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("FUNCTION_RESPONSE_TOO_LARGE");
        output.write(buffer, 0, count);
      }
      return output.toString(StandardCharsets.UTF_8.name());
    }
  }

  private boolean allowedFunction(String name) {
    return "createCodOrder".equals(name)
        || "createOrder".equals(name)
        || "getCheckoutConfiguration".equals(name)
        || "createPaymentIntent".equals(name)
        || "createPhonePeIntent".equals(name)
        || "recoverDeliveryOtp".equals(name)
        || "registerPushToken".equals(name)
        || "unregisterPushToken".equals(name);
  }

  private String normalizeCode(String value) {
    String normalized = String.valueOf(value).trim().toUpperCase(Locale.ROOT).replace('-', '_');
    return normalized.matches("[A-Z0-9_]{1,80}") ? normalized : "FUNCTION_FAILED";
  }
}
