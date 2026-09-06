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
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.savrivo.firebase.SavrivoFirebase;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class TrackingService extends Service implements LocationListener {
    public static final String ACTION_STOP = "com.feastly.rider.action.STOP_TRACKING";
    public static final String ACTION_UPDATE_AUTH = "com.feastly.rider.action.UPDATE_TRACKING_AUTH";
    public static final String ACTION_STATE = "com.feastly.rider.action.TRACKING_STATE";
    public static final String EXTRA_STATE = "state";
    public static final String EXTRA_MESSAGE = "message";
    private static final String CHANNEL_ID = "savrivo_partner_tracking";
    private static final int NOTIFICATION_ID = 5501;
    private static final String TAG = "TrackingService";
    private static final String SESSION_PREFS = "savrivo_partner_tracking_session";
    private static final String SESSION_KEY_ALIAS = "savrivo_partner_tracking_key_v1";
    private static final long HEARTBEAT_INTERVAL_MS = 5_000L;
    private static final long JOB_CHECK_INTERVAL_MS = 30_000L;
    private static final long MAX_LIVE_FIX_AGE_MS = 60_000L;
    private static final long MAX_LAST_KNOWN_AGE_MS = 45_000L;
    private static final float MAX_UPLOAD_ACCURACY_METERS = 80f;
    private static final float MAX_PROXIMITY_ACCURACY_METERS = 50f;

    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private LocationManager locationManager;
    private String customerId = "";
    private String orderId = "";
    private String restaurantId = "";
    private String riderId = "";
    private String riderName = "Scraveit Partner";
    private String riderCity = "";
    private String token = "";
    private String refreshToken = "";
    private String firebaseApiKey = "";
    private String phase = "pickup";
    private boolean availabilityOnly;
    private String lastProximityStatus = "";
    private String proximityCandidate = "";
    private int proximityFixCount;
    private double customerLat = Double.NaN;
    private double customerLng = Double.NaN;
    private Location lastLocation;
    private long lastUploadAt;
    private long lastAcceptedElapsedNanos;
    private long lastHeartbeatAt;
    private long lastJobCheckAt;
    private long authFailureAt;
    private int missingJobChecks;
    private int deniedTrackingWrites;
    private int consecutiveSyncFailures;
    private int lastWriteResponseCode = -1;
    private volatile String firebaseDatabaseRoot = "";
    private volatile boolean stopping;
    private boolean syncFailureReported;
    private String lastReportedState = "";
    private String lastReportedMessage = "";

    private final Runnable heartbeatTask = new Runnable() {
        @Override public void run() {
            if (stopping) return;
            long now = System.currentTimeMillis();
            network.execute(() -> heartbeatAndVerify(now));
            mainHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_UPDATE_AUTH.equals(intent.getAction())) {
            updateCredentials(intent);
            return START_REDELIVER_INTENT;
        }
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            requestStop(safe(intent.getStringExtra("reason")));
            return START_NOT_STICKY;
        }
        String previousCustomerId = customerId;
        String previousOrderId = orderId;
        String previousRestaurantId = restaurantId;
        String previousRiderId = riderId;
        String previousPhase = phase;
        boolean previousAvailabilityOnly = availabilityOnly;
        String previousProximityStatus = lastProximityStatus;
        boolean restored = intent == null ? restoreSession() : readSessionIntent(intent);
        if (!restored) {
            clearPersistedSession();
            publishState("stopped", "Active delivery could not be restored safely.");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (riderName.length() == 0) riderName = "Scraveit Partner";
        if (riderName.length() > 80) riderName = riderName.substring(0, 80);
        if (riderCity.length() > 120) riderCity = riderCity.substring(0, 120);
        phase = availabilityOnly ? "availability" : "delivery".equals(phase) ? "delivery" : "pickup";
        boolean duplicateSession = !stopping
                && previousAvailabilityOnly == availabilityOnly
                && previousCustomerId.equals(customerId)
                && previousOrderId.equals(orderId)
                && previousRestaurantId.equals(restaurantId)
                && previousRiderId.equals(riderId)
                && previousPhase.equals(phase);
        if ((!availabilityOnly && (!safeFirebaseKey(customerId) || !safeFirebaseKey(orderId)))
                || !safeFirebaseKey(riderId)
                || (restaurantId.length() > 0 && !safeFirebaseKey(restaurantId))
                || !safeToken(token)
                || (refreshToken.length() > 0 && !safeRefreshToken(refreshToken))
                || (firebaseApiKey.length() > 0 && !safeFirebaseApiKey(firebaseApiKey))) {
            clearPersistedSession();
            publishState("stopped", "Active delivery credentials were invalid.");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!previousOrderId.equals(orderId)) {
            proximityCandidate = "";
            proximityFixCount = 0;
            missingJobChecks = 0;
            lastJobCheckAt = 0;
        }
        stopping = false;
        authFailureAt = 0;
        if (!persistSession()) {
            clearPersistedSession();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (duplicateSession) {
            if (!previousProximityStatus.equals(lastProximityStatus)) {
                NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
            }
            return START_REDELIVER_INTENT;
        }
        try {
            startForeground(NOTIFICATION_ID, buildNotification());
        } catch (RuntimeException error) {
            Log.e(TAG, "TRACKING_FOREGROUND_START_BLOCKED", error);
            clearPersistedSession();
            publishState("sync_error", availabilityOnly
                    ? "Online availability will resume when Scraveit is back on screen."
                    : "Live tracking will resume when Scraveit is back on screen.");
            stopSelf();
            return START_NOT_STICKY;
        }
        beginLocationUpdates();
        mainHandler.removeCallbacks(heartbeatTask);
        mainHandler.post(heartbeatTask);
        publishState("active", availabilityOnly
                ? "Online availability is active in the background."
                : "Live delivery tracking is active.");
        // Ask Android to redeliver the last validated delivery intent if the process is reclaimed.
        // The service still stops itself for an invalid, expired, or explicitly stopped session.
        return START_REDELIVER_INTENT;
    }

    private void updateCredentials(Intent intent) {
        String updatedToken = safe(intent.getStringExtra("token"));
        String updatedRefresh = safe(intent.getStringExtra("refreshToken"));
        String updatedApiKey = safe(intent.getStringExtra("firebaseApiKey"));
        if (!safeToken(updatedToken) || !safeRefreshToken(updatedRefresh)
                || !safeFirebaseApiKey(updatedApiKey) || riderId.length() == 0) {
            publishState("auth_required", "Secure tracking credentials could not be refreshed.");
            return;
        }
        token = updatedToken;
        refreshToken = updatedRefresh;
        firebaseApiKey = updatedApiKey;
        authFailureAt = 0;
        persistSession();
        publishState("active", "Secure live tracking session refreshed.");
    }

    private boolean readSessionIntent(Intent intent) {
        if (intent == null) return false;
        customerId = safe(intent.getStringExtra("customerId"));
        orderId = safe(intent.getStringExtra("orderId"));
        restaurantId = safe(intent.getStringExtra("restaurantId"));
        riderId = safe(intent.getStringExtra("riderId"));
        riderName = safe(intent.getStringExtra("riderName"));
        riderCity = safe(intent.getStringExtra("riderCity"));
        token = safe(intent.getStringExtra("token"));
        refreshToken = safe(intent.getStringExtra("refreshToken"));
        firebaseApiKey = safe(intent.getStringExtra("firebaseApiKey"));
        phase = safe(intent.getStringExtra("phase"));
        availabilityOnly = intent.getBooleanExtra("availabilityOnly", false);
        String orderStatus = safe(intent.getStringExtra("orderStatus"));
        lastProximityStatus = "Arrived".equals(orderStatus) ? "Arrived"
                : "Near you".equals(orderStatus) ? "Near you" : "";
        customerLat = intent.getDoubleExtra("customerLat", Double.NaN);
        customerLng = intent.getDoubleExtra("customerLng", Double.NaN);
        return true;
    }

    private boolean restoreSession() {
        SharedPreferences preferences = getSharedPreferences(SESSION_PREFS, MODE_PRIVATE);
        if (!preferences.getBoolean("active", false)) return false;
        customerId = preferences.getString("customerId", "");
        orderId = preferences.getString("orderId", "");
        restaurantId = preferences.getString("restaurantId", "");
        riderId = preferences.getString("riderId", "");
        riderName = preferences.getString("riderName", "Scraveit Partner");
        riderCity = preferences.getString("riderCity", "");
        token = decryptSecret(preferences.getString("tokenEnvelope", ""));
        refreshToken = decryptSecret(preferences.getString("refreshTokenEnvelope", ""));
        firebaseApiKey = preferences.getString("firebaseApiKey", "");
        phase = preferences.getString("phase", "pickup");
        availabilityOnly = preferences.getBoolean("availabilityOnly", false);
        lastProximityStatus = preferences.getString("lastProximityStatus", "");
        customerLat = Double.longBitsToDouble(preferences.getLong(
                "customerLat", Double.doubleToRawLongBits(Double.NaN)));
        customerLng = Double.longBitsToDouble(preferences.getLong(
                "customerLng", Double.doubleToRawLongBits(Double.NaN)));
        return true;
    }

    private boolean persistSession() {
        String tokenEnvelope = encryptSecret(token);
        String refreshEnvelope = refreshToken.length() == 0 ? "" : encryptSecret(refreshToken);
        if (tokenEnvelope.length() == 0 || (refreshToken.length() > 0 && refreshEnvelope.length() == 0)) {
            publishState("sync_error", "Secure tracking state could not be protected on this device.");
            return false;
        }
        getSharedPreferences(SESSION_PREFS, MODE_PRIVATE).edit()
                .putBoolean("active", true)
                .putString("customerId", customerId)
                .putString("orderId", orderId)
                .putString("restaurantId", restaurantId)
                .putString("riderId", riderId)
                .putString("riderName", riderName)
                .putString("riderCity", riderCity)
                .putString("tokenEnvelope", tokenEnvelope)
                .putString("refreshTokenEnvelope", refreshEnvelope)
                .putString("firebaseApiKey", firebaseApiKey)
                .putString("phase", phase)
                .putBoolean("availabilityOnly", availabilityOnly)
                .putString("lastProximityStatus", lastProximityStatus)
                .putLong("customerLat", Double.doubleToRawLongBits(customerLat))
                .putLong("customerLng", Double.doubleToRawLongBits(customerLng))
                .apply();
        return true;
    }

    private void clearPersistedSession() {
        getSharedPreferences(SESSION_PREFS, MODE_PRIVATE).edit()
                .remove("active")
                .remove("customerId")
                .remove("orderId")
                .remove("restaurantId")
                .remove("riderId")
                .remove("riderName")
                .remove("riderCity")
                .remove("token")
                .remove("refreshToken")
                .remove("tokenEnvelope")
                .remove("refreshTokenEnvelope")
                .remove("firebaseApiKey")
                .remove("phase")
                .remove("availabilityOnly")
                .remove("lastProximityStatus")
                .remove("customerLat")
                .remove("customerLng")
                .apply();
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
                .setContentTitle(availabilityOnly
                        ? "Scraveit Partner · Online for offers"
                        : "Scraveit Partner · Location active")
                .setContentText(availabilityOnly
                        ? "Location stays active so nearby delivery offers can reach you."
                        : "delivery".equals(phase)
                        ? "Live location is on while you navigate to the customer."
                        : "Live location is on while you navigate to the restaurant.")
                .setSubText(availabilityOnly ? "Availability active" : "Active delivery")
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
                CHANNEL_ID, "Scraveit active delivery", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Visible while Scraveit Partner shares location for an assigned delivery.");
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
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 3000, 0, this);
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER))
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 3000, 0, this);
            Location last = newestLastKnown();
            if (last != null) handleLocation(last, true);
        } catch (Exception error) {
            publishState("sync_error", "Location updates could not start. Check Location settings.");
            stopTracking();
        }
    }

    @SuppressLint("MissingPermission")
    private Location newestLastKnown() {
        Location best = null;
        long now = System.currentTimeMillis();
        try {
            for (String provider : locationManager.getProviders(true)) {
                Location candidate = locationManager.getLastKnownLocation(provider);
                if (usableLocation(candidate, now, true)
                        && (best == null || candidate.getTime() > best.getTime())) best = candidate;
            }
        } catch (Exception ignored) { }
        return best;
    }

    @Override public void onLocationChanged(Location location) {
        handleLocation(location, false);
    }

    private void handleLocation(Location location, boolean fromLastKnown) {
        long now = System.currentTimeMillis();
        if (!usableLocation(location, now, fromLastKnown)) return;
        // Two independent accurate fixes are still required by the backend,
        // but they can now be supplied promptly while the rider is waiting at
        // the doorstep instead of being artificially spaced 6.5 seconds apart.
        if (now - lastUploadAt < 2000) return;
        lastUploadAt = now;
        lastLocation = location;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1
                && location.getElapsedRealtimeNanos() > 0) {
            lastAcceptedElapsedNanos = location.getElapsedRealtimeNanos();
        }
        final double latitude = location.getLatitude();
        final double longitude = location.getLongitude();
        final float accuracy = location.getAccuracy();
        final float bearing = location.hasBearing() ? location.getBearing() : 0f;
        final long fixAge = Math.max(0L, now - location.getTime());
        network.execute(() -> {
            uploadLocation(latitude, longitude, accuracy, bearing, now);
            updateProximity(latitude, longitude, accuracy, fixAge, !fromLastKnown, now);
        });
    }

    private boolean usableLocation(Location location, long now, boolean fromLastKnown) {
        if (location == null || !location.hasAccuracy()
                || location.getAccuracy() < 0f || location.getAccuracy() > MAX_UPLOAD_ACCURACY_METERS) return false;
        long maximumAge = fromLastKnown ? MAX_LAST_KNOWN_AGE_MS : MAX_LIVE_FIX_AGE_MS;
        if (location.getTime() <= 0 || now - location.getTime() > maximumAge
                || location.getTime() - now > 5_000L) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2
                && location.isFromMockProvider()) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            long elapsed = location.getElapsedRealtimeNanos();
            long elapsedNow = SystemClock.elapsedRealtimeNanos();
            if (elapsed <= 0 || elapsed > elapsedNow + 1_000_000_000L
                    || (lastAcceptedElapsedNanos > 0 && elapsed <= lastAcceptedElapsedNanos)) return false;
        }
        double latitude = location.getLatitude(), longitude = location.getLongitude();
        return !Double.isNaN(latitude) && !Double.isNaN(longitude)
                && Math.abs(latitude) <= 90d && Math.abs(longitude) <= 180d;
    }

    private void uploadLocation(double latitude, double longitude, float accuracy, float bearing, long timestamp) {
        if (stopping) return;
        if (!availabilityOnly) {
            String payload = String.format(Locale.US,
                    "{\"customerId\":\"%s\",\"orderId\":\"%s\",\"riderId\":\"%s\",\"riderName\":\"%s\",\"lat\":%.7f,\"lng\":%.7f,\"accuracy\":%.1f,\"bearing\":%.1f,\"updatedAt\":%d,\"status\":\"live\",\"phase\":\"%s\"}",
                    json(customerId), json(orderId), json(riderId), json(riderName),
                    latitude, longitude, accuracy, bearing, timestamp, json(phase));
            boolean trackingWritten = writePatch("/feastly/tracking/" + orderId, payload);
            int trackingResponse = lastWriteResponseCode;
            if (trackingWritten) deniedTrackingWrites = 0;
            else if (trackingResponse == HttpURLConnection.HTTP_FORBIDDEN) {
                deniedTrackingWrites++;
                if (deniedTrackingWrites >= 2) requestStop("assignment_terminal");
            }
        }
        if (!stopping) publishPresence(timestamp, latitude, longitude, accuracy);
        lastHeartbeatAt = timestamp;
    }

    private void heartbeatAndVerify(long timestamp) {
        if (stopping || riderId.length() == 0) return;
        if (timestamp - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS - 1_000L) {
            double latitude = lastLocation == null ? Double.NaN : lastLocation.getLatitude();
            double longitude = lastLocation == null ? Double.NaN : lastLocation.getLongitude();
            float accuracy = lastLocation == null ? Float.NaN : lastLocation.getAccuracy();
            publishPresence(timestamp, latitude, longitude, accuracy);
            lastHeartbeatAt = timestamp;
        }
        if (!availabilityOnly && orderId.length() > 0
                && timestamp - lastJobCheckAt >= JOB_CHECK_INTERVAL_MS) {
            lastJobCheckAt = timestamp;
            verifyActiveJob();
        }
    }

    private boolean publishPresence(long timestamp, double latitude, double longitude, float accuracy) {
        StringBuilder payload = new StringBuilder("{");
        appendPatch(payload, "online", "true");
        appendPatch(payload, "riderId", "\"" + json(riderId) + "\"");
        appendPatch(payload, "riderName", "\"" + json(riderName) + "\"");
        appendPatch(payload, "updatedAt", String.valueOf(timestamp));
        appendPatch(payload, "city", "\"" + json(riderCity) + "\"");
        appendPatch(payload, "activeOrderId", "\"" + json(orderId.length() <= 80 ? orderId : "") + "\"");
        if (!Double.isNaN(latitude) && !Double.isNaN(longitude)
                && !Float.isNaN(accuracy) && accuracy >= 0f) {
            appendPatch(payload, "lat", String.format(Locale.US, "%.7f", latitude));
            appendPatch(payload, "lng", String.format(Locale.US, "%.7f", longitude));
            appendPatch(payload, "accuracy", String.format(Locale.US, "%.1f", accuracy));
        }
        payload.append('}');
        return writePatch("/feastly/riderPresence/" + riderId, payload.toString());
    }

    private void verifyActiveJob() {
        ReadResult result = readValue("/feastly/riderJobs/" + riderId + "/" + orderId);
        if (result.code < 200 || result.code >= 300) return;
        try {
            if (result.body == null || "null".equals(result.body.trim())) {
                missingJobChecks++;
                if (missingJobChecks >= 2) requestStop("assignment_removed");
                return;
            }
            JSONObject pointer = new JSONObject(result.body);
            String status = pointer.optString("status", "");
            String orderStatus = pointer.optString("orderStatus", "");
            String customer = pointer.optString("customerId", "");
            if (!customerId.equals(customer) || "completed".equals(status) || "cancelled".equals(status)
                    || "Delivered".equals(orderStatus) || "Cancelled".equals(orderStatus)) {
                requestStop("assignment_terminal");
                return;
            }
            missingJobChecks = 0;
            if ("Arrived".equals(orderStatus)) lastProximityStatus = "Arrived";
            else if ("Near you".equals(orderStatus) && !"Arrived".equals(lastProximityStatus)) {
                lastProximityStatus = "Near you";
            }
            String serverPhase = pointer.optString("phase", "");
            String nextPhase = ("delivery".equals(serverPhase) || "arrived".equals(serverPhase))
                    ? "delivery" : "pickup";
            if (!phase.equals(nextPhase)) {
                phase = nextPhase;
                NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
            }
            persistSession();
        } catch (Exception error) {
            publishState("sync_error", "The active delivery record could not be verified.");
        }
    }

    private void updateProximity(double latitude, double longitude, float accuracy, long fixAge,
                                 boolean liveFix, long timestamp) {
        if (availabilityOnly || !"delivery".equals(phase)
                || Double.isNaN(customerLat) || Double.isNaN(customerLng)
                || !liveFix || accuracy > MAX_PROXIMITY_ACCURACY_METERS || fixAge > 20_000L) return;
        float[] result = new float[1];
        Location.distanceBetween(latitude, longitude, customerLat, customerLng, result);
        String candidate = result[0] <= 100
                ? "Arrived" : result[0] <= 700 ? "Near you" : "";
        if (candidate.length() == 0 || "Arrived".equals(lastProximityStatus)) {
            proximityCandidate = "";
            proximityFixCount = 0;
            return;
        }
        if (candidate.equals(proximityCandidate)) proximityFixCount++;
        else { proximityCandidate = candidate; proximityFixCount = 1; }
        int requiredFixes = 2;
        if (proximityFixCount < requiredFixes || candidate.equals(lastProximityStatus)) return;
        // The device publishes signed-in GPS evidence only. A backend trigger must validate the
        // assigned rider, freshness, accuracy and distance before advancing the order lifecycle.
        if (publishProximityEvidence(candidate, result[0], accuracy, timestamp)) {
            lastProximityStatus = candidate;
            persistSession();
            proximityCandidate = "";
            proximityFixCount = 0;
        }
    }

    private boolean publishProximityEvidence(
            String candidate, float distanceMeters, float accuracy, long timestamp) {
        String payload = String.format(Locale.US,
                "{\"candidate\":\"%s\",\"distanceMeters\":%.1f,\"accuracy\":%.1f,"
                        + "\"consecutiveFixes\":%d,\"detectedAt\":%d,\"riderId\":\"%s\","
                        + "\"orderId\":\"%s\",\"phase\":\"delivery\",\"source\":\"gps\"}",
                json(candidate), distanceMeters, accuracy, proximityFixCount, timestamp,
                json(riderId), json(orderId));
        return writePatch("/feastly/tracking/" + orderId + "/proximityEvidence", payload);
    }

    private void appendPatch(StringBuilder payload, String path, String jsonValue) {
        if (payload.length() > 1) payload.append(',');
        payload.append('\"').append(path).append("\":").append(jsonValue);
    }

    private boolean writePatch(String path, String jsonValue) {
        int responseCode = -1;
        for (int attempt = 0; attempt < 3; attempt++) {
            responseCode = sendPatch(path, jsonValue);
            lastWriteResponseCode = responseCode;
            if (responseCode >= 200 && responseCode < 300) {
                consecutiveSyncFailures = 0;
                if (authFailureAt > 0 || syncFailureReported) {
                    authFailureAt = 0;
                    syncFailureReported = false;
                    publishState("active", "Live delivery tracking recovered.");
                }
                return true;
            }
            if (responseCode == HttpURLConnection.HTTP_UNAUTHORIZED) {
                if (refreshIdToken()) continue;
                handleAuthenticationFailure();
                return false;
            }
            if (!transientResponse(responseCode) || attempt == 2) break;
            backoff(attempt);
        }
        if (responseCode == HttpURLConnection.HTTP_FORBIDDEN) {
            consecutiveSyncFailures = 0;
            syncFailureReported = true;
            publishState("sync_error",
                    "Live tracking permission was rejected. Ask Scraveit support to verify this assignment.");
            return false;
        }
        consecutiveSyncFailures++;
        if (consecutiveSyncFailures >= 2) {
            syncFailureReported = true;
            publishState("sync_error", "Live tracking could not reach Scraveit. It will retry automatically.");
        }
        return false;
    }

    private int sendPatch(String path, String jsonValue) {
        HttpURLConnection connection = null;
        try {
            String databaseRoot = firebaseDatabaseRoot();
            if (databaseRoot.length() == 0) return -1;
            String endpoint = databaseRoot + path + ".json?auth="
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

    private ReadResult readValue(String path) {
        ReadResult result = new ReadResult(-1, "");
        for (int attempt = 0; attempt < 3 && !stopping; attempt++) {
            result = sendGet(path);
            if (result.code >= 200 && result.code < 300) {
                consecutiveSyncFailures = 0;
                if (syncFailureReported) {
                    syncFailureReported = false;
                    publishState("active", "Live delivery tracking recovered.");
                }
                return result;
            }
            if (result.code == HttpURLConnection.HTTP_UNAUTHORIZED) {
                if (refreshIdToken()) continue;
                handleAuthenticationFailure();
                return result;
            }
            if (!transientResponse(result.code) || attempt == 2) break;
            backoff(attempt);
        }
        if (result.code == HttpURLConnection.HTTP_FORBIDDEN) {
            consecutiveSyncFailures = 0;
            syncFailureReported = true;
            publishState("sync_error", "The active assignment can no longer be read.");
            return result;
        }
        consecutiveSyncFailures++;
        if (consecutiveSyncFailures >= 2) {
            syncFailureReported = true;
            publishState("sync_error", "The active assignment could not be verified. Tracking will retry.");
        }
        return result;
    }

    private ReadResult sendGet(String path) {
        HttpURLConnection connection = null;
        try {
            String databaseRoot = firebaseDatabaseRoot();
            if (databaseRoot.length() == 0) return new ReadResult(-1, "");
            String endpoint = databaseRoot + path + ".json?auth="
                    + java.net.URLEncoder.encode(token, "UTF-8");
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(9000);
            connection.setReadTimeout(9000);
            int code = connection.getResponseCode();
            String body = code >= 200 && code < 300 ? readResponse(connection) : "";
            return new ReadResult(code, body);
        } catch (Exception ignored) {
            return new ReadResult(-1, "");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String firebaseDatabaseRoot() {
        String cached = firebaseDatabaseRoot;
        if (cached.length() > 0) return cached;
        try {
            FirebaseApp firebaseApp = SavrivoFirebase.ensureInitialized(this);
            String configured = firebaseApp == null ? "" : safe(firebaseApp.getOptions().getDatabaseUrl());
            if (!configured.startsWith("https://")) return "";
            while (configured.endsWith("/")) configured = configured.substring(0, configured.length() - 1);
            firebaseDatabaseRoot = configured;
            return configured;
        } catch (Exception ignored) {
            return "";
        }
    }

    private boolean transientResponse(int responseCode) {
        return responseCode < 0 || responseCode == 408 || responseCode == 425
                || responseCode == 429 || responseCode >= 500;
    }

    private void backoff(int attempt) {
        try { Thread.sleep(attempt == 0 ? 450L : 1_200L); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    }

    private void handleAuthenticationFailure() {
        if (authFailureAt > 0) return;
        authFailureAt = System.currentTimeMillis();
        final long failure = authFailureAt;
        publishState("auth_required", "Refreshing the secure delivery session…");
        mainHandler.postDelayed(() -> {
            if (!stopping && authFailureAt == failure) requestStop("auth_expired");
        }, 60_000L);
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
            authFailureAt = 0;
            persistSession();
            return true;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static class ReadResult {
        final int code;
        final String body;

        ReadResult(int code, String body) {
            this.code = code;
            this.body = body;
        }
    }

    private SecretKey sessionKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(SESSION_KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                SESSION_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private String encryptSecret(String value) {
        if (value == null || value.length() == 0) return "";
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, sessionKey());
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "."
                    + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        } catch (Exception ignored) {
            return "";
        }
    }

    private String decryptSecret(String envelope) {
        if (envelope == null || envelope.length() == 0) return "";
        try {
            String[] pieces = envelope.split("\\.", 2);
            if (pieces.length != 2) return "";
            byte[] iv = Base64.decode(pieces[0], Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(pieces[1], Base64.NO_WRAP);
            if (iv.length < 12 || encrypted.length < 16) return "";
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, sessionKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return "";
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

    private void requestStop(String reason) {
        if (stopping) return;
        stopping = true;
        mainHandler.removeCallbacks(heartbeatTask);
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (Exception ignored) { }
        }
        final String safeReason = reason.length() == 0 ? "stopped" : reason;
        if ("location_off".equals(safeReason)) {
            publishState("location_off", "Phone Location was turned off. Live tracking stopped.");
        }
        network.execute(() -> {
            publishFinalCloudState(safeReason);
            mainHandler.post(() -> finishStop(safeReason));
        });
    }

    private void publishFinalCloudState(String reason) {
        if (riderId.length() == 0 || token.length() == 0
                || "auth_expired".equals(reason)) return;
        long timestamp = System.currentTimeMillis();
        boolean offline = "offline".equals(reason) || "location_off".equals(reason);
        StringBuilder changes = new StringBuilder("{");
        appendPatch(changes, "riderPresence/" + riderId + "/online", offline ? "false" : "true");
        appendPatch(changes, "riderPresence/" + riderId + "/riderId", "\"" + json(riderId) + "\"");
        appendPatch(changes, "riderPresence/" + riderId + "/riderName", "\"" + json(riderName) + "\"");
        appendPatch(changes, "riderPresence/" + riderId + "/updatedAt", String.valueOf(timestamp));
        appendPatch(changes, "riderPresence/" + riderId + "/city", "\"" + json(riderCity) + "\"");
        appendPatch(changes, "riderPresence/" + riderId + "/activeOrderId", "\"\"");
        if (offline && !availabilityOnly && orderId.length() > 0) {
            appendPatch(changes, "tracking/" + orderId + "/status",
                    "\"" + ("location_off".equals(reason) ? "location_off" : "stopped") + "\"");
            appendPatch(changes, "tracking/" + orderId + "/updatedAt", String.valueOf(timestamp));
        }
        changes.append('}');
        writePatch("/feastly", changes.toString());
    }

    private void finishStop(String reason) {
        clearPersistedSession();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        if ("auth_expired".equals(reason)) {
            publishState("auth_required", "Secure tracking session expired. Open Scraveit Partner to reconnect.");
        } else if (!"location_off".equals(reason)) {
            publishState("stopped", "Live delivery tracking stopped.");
        }
        stopSelf();
    }

    private void publishState(String state, String message) {
        String safeState = safe(state);
        String safeMessage = safe(message);
        if (safeState.equals(lastReportedState) && safeMessage.equals(lastReportedMessage)) return;
        lastReportedState = safeState;
        lastReportedMessage = safeMessage;
        getSharedPreferences(SESSION_PREFS, MODE_PRIVATE).edit()
                .putString("lastState", safeState)
                .putString("lastMessage", safeMessage)
                .apply();
        Intent update = new Intent(ACTION_STATE);
        update.setPackage(getPackageName());
        update.putExtra(EXTRA_STATE, safeState);
        update.putExtra(EXTRA_MESSAGE, safeMessage);
        sendBroadcast(update);
    }

    public static String lastState(Context context) {
        return context.getSharedPreferences(SESSION_PREFS, MODE_PRIVATE)
                .getString("lastState", "stopped");
    }

    public static String lastMessage(Context context) {
        return context.getSharedPreferences(SESSION_PREFS, MODE_PRIVATE)
                .getString("lastMessage", "");
    }

    private void stopTracking() {
        stopping = true;
        mainHandler.removeCallbacks(heartbeatTask);
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (Exception ignored) { }
        }
        clearPersistedSession();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        publishState("stopped", "Live delivery tracking stopped.");
        stopSelf();
    }

    @Override public void onDestroy() {
        mainHandler.removeCallbacks(heartbeatTask);
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
        if (!enabled) requestStop("location_off");
    }
    @Override public void onProviderEnabled(String provider) {
        if (!stopping) beginLocationUpdates();
    }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
}
