package com.feastly.rider;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class TrackingService extends Service implements LocationListener {
    public static final String ACTION_STOP = "com.feastly.rider.action.STOP_TRACKING";
    private static final String CHANNEL_ID = "savrivo_partner_tracking";
    private static final int NOTIFICATION_ID = 5501;
    private static final String DATABASE_ROOT = "https://kamju-a4750-default-rtdb.firebaseio.com";

    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private LocationManager locationManager;
    private String customerId = "";
    private String orderId = "";
    private String restaurantId = "";
    private String riderId = "";
    private String riderName = "Savrivo Partner";
    private String token = "";
    private String refreshToken = "";
    private String firebaseApiKey = "";
    private String phase = "pickup";
    private String lastProximityStatus = "";
    private String proximityCandidate = "";
    private int proximityFixCount;
    private double customerLat = Double.NaN;
    private double customerLng = Double.NaN;
    private Location lastLocation;
    private long lastUploadAt;

    @Override public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopTracking();
            return START_NOT_STICKY;
        }
        if (intent == null) return START_NOT_STICKY;
        customerId = safe(intent.getStringExtra("customerId"));
        orderId = safe(intent.getStringExtra("orderId"));
        restaurantId = safe(intent.getStringExtra("restaurantId"));
        riderId = safe(intent.getStringExtra("riderId"));
        riderName = safe(intent.getStringExtra("riderName"));
        token = safe(intent.getStringExtra("token"));
        refreshToken = safe(intent.getStringExtra("refreshToken"));
        firebaseApiKey = safe(intent.getStringExtra("firebaseApiKey"));
        phase = safe(intent.getStringExtra("phase"));
        if (riderName.length() == 0) riderName = "Savrivo Partner";
        if (riderName.length() > 80) riderName = riderName.substring(0, 80);
        phase = "delivery".equals(phase) ? "delivery" : "pickup";
        customerLat = intent.getDoubleExtra("customerLat", Double.NaN);
        customerLng = intent.getDoubleExtra("customerLng", Double.NaN);
        if (!safeFirebaseKey(customerId) || !safeFirebaseKey(orderId) || !safeFirebaseKey(riderId)
                || (restaurantId.length() > 0 && !safeFirebaseKey(restaurantId))
                || !safeToken(token)
                || (refreshToken.length() > 0 && !safeRefreshToken(refreshToken))
                || (firebaseApiKey.length() > 0 && !safeFirebaseApiKey(firebaseApiKey))) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFICATION_ID, buildNotification());
        beginLocationUpdates();
        // Ask Android to redeliver the last validated delivery intent if the process is reclaimed.
        // The service still stops itself for an invalid, expired, or explicitly stopped session.
        return START_REDELIVER_INTENT;
    }

    private Notification buildNotification() {
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, 0, openApp, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        builder.setSmallIcon(com.feastly.rider.R.drawable.savrivo_partner_notification)
                .setColor(0xFF155EEF)
                .setContentTitle("Savrivo Partner · Location active")
                .setContentText("delivery".equals(phase)
                        ? "Live location is on while you navigate to the customer."
                        : "Live location is on while you navigate to the restaurant.")
                .setSubText("Active delivery")
                .setContentIntent(pending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setLocalOnly(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setShowWhen(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Savrivo active delivery", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Visible while Savrivo Partner shares location for an assigned delivery.");
        channel.enableVibration(false);
        channel.setSound(null, null);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    @SuppressLint("MissingPermission")
    private void beginLocationUpdates() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopTracking();
            return;
        }
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (Exception ignored) { }
        }
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (locationManager == null) {
            stopTracking();
            return;
        }
        try {
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 7000, 8, this);
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER))
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 7000, 8, this);
            Location last = newestLastKnown();
            if (last != null) onLocationChanged(last);
        } catch (Exception error) {
            stopTracking();
        }
    }

    @SuppressLint("MissingPermission")
    private Location newestLastKnown() {
        Location best = null;
        try {
            for (String provider : locationManager.getProviders(true)) {
                Location candidate = locationManager.getLastKnownLocation(provider);
                if (candidate != null && (best == null || candidate.getTime() > best.getTime())) best = candidate;
            }
        } catch (Exception ignored) { }
        return best;
    }

    @Override public void onLocationChanged(Location location) {
        long now = System.currentTimeMillis();
        if (!usableLocation(location, now)) return;
        if (now - lastUploadAt < 6500) return;
        lastUploadAt = now;
        lastLocation = location;
        final double latitude = location.getLatitude();
        final double longitude = location.getLongitude();
        final float accuracy = location.getAccuracy();
        final float bearing = location.hasBearing() ? location.getBearing() : 0f;
        network.execute(() -> {
            uploadLocation(latitude, longitude, accuracy, bearing, now);
            updateProximity(latitude, longitude, now);
        });
    }

    private boolean usableLocation(Location location, long now) {
        if (location == null || !location.hasAccuracy() || location.getAccuracy() > 100f) return false;
        if (location.getTime() <= 0 || Math.abs(now - location.getTime()) > 120000) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2
                && location.isFromMockProvider()) return false;
        double latitude = location.getLatitude(), longitude = location.getLongitude();
        return !Double.isNaN(latitude) && !Double.isNaN(longitude)
                && Math.abs(latitude) <= 90d && Math.abs(longitude) <= 180d;
    }

    private void uploadLocation(double latitude, double longitude, float accuracy, float bearing, long timestamp) {
        String payload = String.format(Locale.US,
                "{\"customerId\":\"%s\",\"orderId\":\"%s\",\"riderId\":\"%s\",\"riderName\":\"%s\",\"lat\":%.7f,\"lng\":%.7f,\"accuracy\":%.1f,\"bearing\":%.1f,\"updatedAt\":%d,\"status\":\"live\",\"phase\":\"%s\"}",
                json(customerId), json(orderId), json(riderId), json(riderName),
                latitude, longitude, accuracy, bearing, timestamp, json(phase));
        writePatch("/feastly/tracking/" + orderId, payload);
    }

    private void updateProximity(double latitude, double longitude, long timestamp) {
        if (!"delivery".equals(phase) || Double.isNaN(customerLat) || Double.isNaN(customerLng)) return;
        float[] result = new float[1];
        Location.distanceBetween(latitude, longitude, customerLat, customerLng, result);
        String candidate = result[0] <= 100 && lastLocation != null && lastLocation.getAccuracy() <= 50f
                ? "Arrived" : result[0] <= 700 ? "Near you" : "";
        if (candidate.length() == 0 || "Arrived".equals(lastProximityStatus)) {
            proximityCandidate = "";
            proximityFixCount = 0;
            return;
        }
        if (candidate.equals(proximityCandidate)) proximityFixCount++;
        else { proximityCandidate = candidate; proximityFixCount = 1; }
        if (proximityFixCount < 2 || candidate.equals(lastProximityStatus)) return;
        // Do not mark the milestone as sent until Firebase accepts the complete atomic patch.
        // Otherwise a transient failure would prevent every later GPS fix from retrying it.
        if (updateOrderStatus(candidate, timestamp)) {
            lastProximityStatus = candidate;
            proximityCandidate = "";
            proximityFixCount = 0;
        }
    }

    private boolean updateOrderStatus(String status, long timestamp) {
        String canonical = "orders/" + customerId + "/" + orderId;
        String eventId = "e_" + timestamp + "_rider_auto";
        String event = "{\"status\":\"" + json(status) + "\",\"at\":" + timestamp
                + ",\"actorId\":\"" + json(riderId) + "\",\"actorRole\":\"rider\"}";
        StringBuilder payload = new StringBuilder("{");
        appendPatch(payload, canonical + "/status", "\"" + json(status) + "\"");
        appendPatch(payload, canonical + "/updatedAt", String.valueOf(timestamp));
        appendPatch(payload, canonical + "/statusHistory/" + eventId, event);
        if (restaurantId.length() > 0) {
            String mirror = "restaurantOrders/" + restaurantId + "/" + customerId + "/" + orderId;
            appendPatch(payload, mirror + "/status", "\"" + json(status) + "\"");
            appendPatch(payload, mirror + "/updatedAt", String.valueOf(timestamp));
            appendPatch(payload, mirror + "/statusHistory/" + eventId, event);
        }
        appendPatch(payload, "riderJobs/" + riderId + "/" + orderId + "/phase",
                "\"" + ("Arrived".equals(status) ? "arrived" : "delivery") + "\"");
        appendPatch(payload, "riderJobs/" + riderId + "/" + orderId + "/status", "\"active\"");
        appendPatch(payload, "riderJobs/" + riderId + "/" + orderId + "/updatedAt", String.valueOf(timestamp));
        payload.append('}');
        return writePatch("/feastly", payload.toString());
    }

    private void appendPatch(StringBuilder payload, String path, String jsonValue) {
        if (payload.length() > 1) payload.append(',');
        payload.append('\"').append(path).append("\":").append(jsonValue);
    }

    private void publishTrackingState(String state) {
        if (orderId.length() == 0 || token.length() == 0) return;
        final long timestamp = System.currentTimeMillis();
        network.execute(() -> {
            double lat = lastLocation == null ? 0d : lastLocation.getLatitude();
            double lng = lastLocation == null ? 0d : lastLocation.getLongitude();
            String payload = String.format(Locale.US,
                    "{\"customerId\":\"%s\",\"orderId\":\"%s\",\"riderId\":\"%s\",\"riderName\":\"%s\",\"lat\":%.7f,\"lng\":%.7f,\"updatedAt\":%d,\"status\":\"%s\",\"phase\":\"%s\"}",
                    json(customerId), json(orderId), json(riderId), json(riderName),
                    lat, lng, timestamp, json(state), json(phase));
            StringBuilder changes = new StringBuilder("{");
            appendPatch(changes, "tracking/" + orderId, payload);
            if ("location_off".equals(state)) {
                appendPatch(changes, "riderPresence/" + riderId + "/online", "false");
                appendPatch(changes, "riderPresence/" + riderId + "/updatedAt", String.valueOf(timestamp));
            }
            changes.append('}');
            writePatch("/feastly", changes.toString());
        });
    }

    private void writeValue(String path, String jsonValue) {
        HttpURLConnection connection = null;
        try {
            String endpoint = DATABASE_ROOT + path + ".json?auth="
                    + java.net.URLEncoder.encode(token, "UTF-8");
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("PUT");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setConnectTimeout(9000);
            connection.setReadTimeout(9000);
            connection.setDoOutput(true);
            byte[] bytes = jsonValue.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            connection.getResponseCode();
        } catch (Exception ignored) { }
        finally { if (connection != null) connection.disconnect(); }
    }

    private boolean writePatch(String path, String jsonValue) {
        int responseCode = sendPatch(path, jsonValue);
        if (responseCode == HttpURLConnection.HTTP_UNAUTHORIZED && refreshIdToken()) {
            responseCode = sendPatch(path, jsonValue);
        }
        if (responseCode == HttpURLConnection.HTTP_UNAUTHORIZED) stopSelf();
        return responseCode >= 200 && responseCode < 300;
    }

    private int sendPatch(String path, String jsonValue) {
        HttpURLConnection connection = null;
        try {
            String endpoint = DATABASE_ROOT + path + ".json?auth="
                    + java.net.URLEncoder.encode(token, "UTF-8");
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("X-HTTP-Method-Override", "PATCH");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setConnectTimeout(9000);
            connection.setReadTimeout(9000);
            connection.setDoOutput(true);
            byte[] bytes = jsonValue.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            return connection.getResponseCode();
        } catch (Exception ignored) {
            return -1;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean refreshIdToken() {
        if (!safeRefreshToken(refreshToken) || !safeFirebaseApiKey(firebaseApiKey)) return false;
        HttpURLConnection connection = null;
        try {
            String endpoint = "https://securetoken.googleapis.com/v1/token?key="
                    + java.net.URLEncoder.encode(firebaseApiKey, "UTF-8");
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
            connection.setConnectTimeout(9000);
            connection.setReadTimeout(9000);
            connection.setDoOutput(true);
            String payload = "grant_type=refresh_token&refresh_token="
                    + java.net.URLEncoder.encode(refreshToken, "UTF-8");
            byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) return false;
            JSONObject response = new JSONObject(readResponse(connection));
            String updatedToken = response.optString("id_token", "");
            String updatedRefresh = response.optString("refresh_token", refreshToken);
            if (!safeToken(updatedToken) || !safeRefreshToken(updatedRefresh)) return false;
            token = updatedToken;
            refreshToken = updatedRefresh;
            return true;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readResponse(HttpURLConnection connection) throws Exception {
        StringBuilder body = new StringBuilder();
        try (InputStream input = connection.getInputStream();
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            char[] chunk = new char[1024];
            int count;
            while ((count = reader.read(chunk)) != -1) body.append(chunk, 0, count);
        }
        return body.toString();
    }

    private String encodePath(String value) {
        try { return java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20"); }
        catch (Exception ignored) { return value; }
    }

    private String json(String value) {
        return safe(value).replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "");
    }

    private String safe(String value) { return value == null ? "" : value; }

    private boolean safeFirebaseKey(String value) {
        return value != null && value.length() > 0 && value.length() <= 128
                && value.matches("[A-Za-z0-9_-]+");
    }

    private boolean safeToken(String value) {
        return value != null && value.length() >= 32 && value.length() <= 8192
                && value.matches("[A-Za-z0-9._-]+");
    }

    private boolean safeRefreshToken(String value) {
        return value != null && value.length() >= 32 && value.length() <= 8192
                && value.matches("[A-Za-z0-9._~\\-]+");
    }

    private boolean safeFirebaseApiKey(String value) {
        return value != null && value.length() >= 20 && value.length() <= 128
                && value.matches("[A-Za-z0-9_-]+");
    }

    private void stopTracking() {
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (Exception ignored) { }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    @Override public void onDestroy() {
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (Exception ignored) { }
        }
        network.shutdownNow();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onProviderDisabled(String provider) {
        if (locationManager == null) return;
        boolean enabled = false;
        try { enabled = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER); }
        catch (Exception ignored) { }
        if (!enabled) publishTrackingState("location_off");
    }
    @Override public void onProviderEnabled(String provider) {
        beginLocationUpdates();
    }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
}
