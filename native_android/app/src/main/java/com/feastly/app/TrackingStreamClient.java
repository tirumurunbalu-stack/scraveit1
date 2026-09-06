package com.feastly.app;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

/** A narrow Firebase REST stream for one authenticated active order. */
final class TrackingStreamClient {
  interface Listener {
    void onConnected();
    void onEvent(String eventName, JSONObject envelope);
    void onTemporaryFailure();
    void onAuthenticationExpired();
  }

  private final String databaseBaseUrl;
  private final String orderId;
  private final String firebaseIdToken;
  private final Listener listener;
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private volatile boolean running;
  private volatile HttpsURLConnection connection;

  TrackingStreamClient(String databaseBaseUrl, String orderId, String firebaseIdToken,
                       Listener listener) {
    this.databaseBaseUrl = databaseBaseUrl == null ? "" : databaseBaseUrl.replaceAll("/+$", "");
    this.orderId = orderId == null ? "" : orderId;
    this.firebaseIdToken = firebaseIdToken == null ? "" : firebaseIdToken;
    this.listener = listener;
  }

  boolean canConnect() {
    return databaseBaseUrl.startsWith("https://")
        && TrackingContract.validOrderId(orderId)
        && firebaseIdToken.length() >= 100
        && firebaseIdToken.length() <= 8_192
        && firebaseIdToken.matches("[A-Za-z0-9._-]+");
  }

  void start() {
    if (running || !canConnect()) return;
    running = true;
    executor.execute(this::streamWithReconnect);
  }

  void stop() {
    running = false;
    HttpsURLConnection active = connection;
    connection = null;
    if (active != null) active.disconnect();
    executor.shutdownNow();
  }

  private void streamWithReconnect() {
    long backoffMs = 1_000L;
    while (running && !Thread.currentThread().isInterrupted()) {
      try {
        int result = connectOnce();
        if (result == HttpURLConnection.HTTP_UNAUTHORIZED
            || result == HttpURLConnection.HTTP_FORBIDDEN) {
          running = false;
          listener.onAuthenticationExpired();
          return;
        }
        if (!running) return;
      } catch (Exception ignored) {
        if (!running) return;
      } finally {
        HttpsURLConnection active = connection;
        connection = null;
        if (active != null) active.disconnect();
      }
      listener.onTemporaryFailure();
      try { Thread.sleep(backoffMs); }
      catch (InterruptedException ignored) { Thread.currentThread().interrupt(); return; }
      backoffMs = Math.min(20_000L, backoffMs * 2L);
    }
  }

  private int connectOnce() throws Exception {
    String encodedOrder = URLEncoder.encode(orderId, StandardCharsets.UTF_8.name());
    String encodedToken = URLEncoder.encode(firebaseIdToken, StandardCharsets.UTF_8.name());
    java.net.URL url = new java.net.URL(databaseBaseUrl + "/feastly/tracking/"
        + encodedOrder + ".json?auth=" + encodedToken);
    HttpsURLConnection stream = (HttpsURLConnection) url.openConnection();
    connection = stream;
    stream.setRequestMethod("GET");
    stream.setRequestProperty("Accept", "text/event-stream");
    stream.setRequestProperty("Cache-Control", "no-cache");
    stream.setConnectTimeout(12_000);
    stream.setReadTimeout(70_000);
    stream.setUseCaches(false);
    int status = stream.getResponseCode();
    if (status != HttpURLConnection.HTTP_OK) {
      drainQuietly(stream.getErrorStream());
      return status;
    }
    listener.onConnected();
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(
        stream.getInputStream(), StandardCharsets.UTF_8))) {
      String eventName = "";
      StringBuilder data = new StringBuilder();
      String line;
      while (running && (line = reader.readLine()) != null) {
        if (line.isEmpty()) {
          dispatch(eventName, data.toString());
          eventName = "";
          data.setLength(0);
        } else if (line.startsWith("event:")) {
          eventName = line.substring(6).trim();
        } else if (line.startsWith("data:")) {
          if (data.length() > 0) data.append('\n');
          if (data.length() < 256_000) data.append(line.substring(5).trim());
        }
      }
    }
    return status;
  }

  private void dispatch(String eventName, String rawData) {
    if (!running || rawData == null || rawData.isEmpty()) return;
    if ("auth_revoked".equals(eventName) || "cancel".equals(eventName)) {
      running = false;
      listener.onAuthenticationExpired();
      return;
    }
    if (!"put".equals(eventName) && !"patch".equals(eventName)) return;
    try { listener.onEvent(eventName, new JSONObject(rawData)); }
    catch (Exception ignored) { }
  }

  private static void drainQuietly(InputStream input) {
    if (input == null) return;
    try (InputStream stream = input) {
      byte[] buffer = new byte[512];
      while (stream.read(buffer) != -1) { }
    } catch (Exception ignored) { }
  }
}
