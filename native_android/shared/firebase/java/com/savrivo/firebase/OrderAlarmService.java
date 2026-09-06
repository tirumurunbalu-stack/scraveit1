package com.savrivo.firebase;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

import org.json.JSONObject;

import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

/** A restartable, exact-event-id foreground service for operational accept/decline alerts. */
public final class OrderAlarmService extends Service {
    private static final String ACTION_START = "com.savrivo.firebase.START_ORDER_ALARM";
    private static final String ACTION_STOP = "com.savrivo.firebase.STOP_ORDER_ALARM";
    private static final String ACTION_PAUSE = "com.savrivo.firebase.PAUSE_ORDER_ALARM";
    private static final String EXTRA_ALARM_ID = "alarmId";
    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_BODY = "body";
    private static final String EXTRA_ORDER_ID = "orderId";
    private static final String EXTRA_ISSUED_AT = "issuedAt";
    private static final String EXTRA_EXPIRES_AT = "expiresAt";
    private static final String PREFS = "savrivo.active.action.alarms";
    private static final String KEY_ALARMS = "alarms";
    private static final String KEY_STOPPED = "stopped";
    private static final long STOP_TOMBSTONE_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final int FOREGROUND_ID = 0x30101010;
    private static final String TAG = "SavrivoOrderAlarm";
    private static final long PLAYBACK_WATCHDOG_MS = 2_000L;

    private MediaPlayer alarmPlayer;
    private Vibrator vibrator;
    private final Handler playbackHandler = new Handler(Looper.getMainLooper());
    private final Runnable playbackWatchdog = new Runnable() {
        @Override public void run() {
            JSONObject active = pruneExpiredAlarms();
            if (active.length() == 0) {
                stopAll();
                return;
            }
            if (alarmPlayer == null || !safeIsPlaying(alarmPlayer)) {
                Log.w(TAG, "ALARM_PLAYBACK_RECOVERY_STARTED");
                releasePlayer();
                beginSoundAndVibration();
            }
            playbackHandler.postDelayed(this, PLAYBACK_WATCHDOG_MS);
        }
    };

    public static boolean start(Context context, String alarmId, String title, String body, String orderId) {
        return start(context, alarmId, title, body, orderId, 0L, 0L);
    }

    public static boolean start(
            Context context, String alarmId, String title, String body, String orderId, long issuedAt) {
        return start(context, alarmId, title, body, orderId, issuedAt, 0L);
    }

    public static boolean start(
            Context context, String alarmId, String title, String body, String orderId,
            long issuedAt, long expiresAt) {
        if (!validAlarmId(alarmId)) return false;
        if (expiresAt > 0L && expiresAt <= System.currentTimeMillis()) {
            pause(context, alarmId);
            Log.i(TAG, "EXPIRED_ALARM_START_IGNORED alarmId=" + alarmId);
            return false;
        }
        if (wasAuthoritativelyStopped(context, alarmId, issuedAt)) {
            Log.i(TAG, "DUPLICATE_EVENT_IGNORED alarmId=" + alarmId);
            return false;
        }
        Intent intent = new Intent(context, OrderAlarmService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_ALARM_ID, alarmId)
                .putExtra(EXTRA_TITLE, trim(title, 120))
                .putExtra(EXTRA_BODY, trim(body, 240))
                .putExtra(EXTRA_ORDER_ID, trim(orderId, 120))
                .putExtra(EXTRA_ISSUED_AT, issuedAt)
                .putExtra(EXTRA_EXPIRES_AT, expiresAt);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
            else context.startService(intent);
            return true;
        } catch (Exception error) {
            Log.w(TAG, "BACKGROUND_ALARM_SERVICE_BLOCKED alarmId=" + alarmId, error);
            // A high-priority data FCM normally has a foreground-service launch exemption. If the
            // OS revokes it, the messaging service posts an alarm-channel notification fallback.
            return false;
        }
    }

    public static void stop(Context context, String alarmId) {
        if (!validAlarmId(alarmId)) return;
        markAuthoritativelyStopped(context, alarmId);
        removeStored(context, alarmId);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(SavrivoNotifications.stableId(notificationNamespace(context), alarmId));
        Log.i(TAG, "ALARM_STOP_REQUESTED alarmId=" + alarmId);
        Intent intent = new Intent(context, OrderAlarmService.class)
                .setAction(ACTION_STOP)
                .putExtra(EXTRA_ALARM_ID, alarmId);
        try { context.startService(intent); }
        catch (Exception ignored) {
            // Stored state and the notification were already cleared above.
        }
    }

    /**
     * Reconciles persisted Restaurant alarms with a freshly fetched authoritative pending set.
     * This repairs a missed STOP_ORDER_ALARM push after process death/reconnect without touching
     * rider offers or stopping any other still-pending Restaurant order.
     */
    public static void reconcileRestaurantOrders(
            Context context, Set<String> knownOrderIds, Set<String> pendingOrderIds) {
        if (context == null || !"restaurant".equals(SavrivoFirebase.appRole(context))) return;
        Set<String> knownAlarmIds = new HashSet<>();
        if (knownOrderIds != null) {
            for (String orderId : knownOrderIds) {
                String alarmId = "order:" + orderId;
                if (validAlarmId(alarmId)) knownAlarmIds.add(alarmId);
            }
        }
        Set<String> authoritativeAlarmIds = new HashSet<>();
        if (pendingOrderIds != null) {
            for (String orderId : pendingOrderIds) {
                String alarmId = "order:" + orderId;
                if (validAlarmId(alarmId)) authoritativeAlarmIds.add(alarmId);
            }
        }

        Set<String> staleAlarmIds = new HashSet<>();
        SharedPreferences preferences = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        try {
            JSONObject stored = new JSONObject(preferences.getString(KEY_ALARMS, "{}"));
            Iterator<String> alarmIds = stored.keys();
            while (alarmIds.hasNext()) {
                String alarmId = alarmIds.next();
                if (alarmId.startsWith("order:")
                        && knownAlarmIds.contains(alarmId)
                        && !authoritativeAlarmIds.contains(alarmId)) {
                    staleAlarmIds.add(alarmId);
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "RESTAURANT_ALARM_RECONCILIATION_READ_FAILED", error);
            return;
        }

        for (String alarmId : staleAlarmIds) {
            String orderId = alarmId.substring("order:".length());
            stop(context, alarmId);
            SavrivoPushStore.removeRestaurantNewOrder(context, orderId);
            Log.i(TAG, "STALE_RESTAURANT_ALARM_RECONCILED orderId=" + orderId);
        }
    }

    /** Temporarily silences an offer without creating a generation tombstone. */
    public static void pause(Context context, String alarmId) {
        if (!validAlarmId(alarmId)) return;
        removeStored(context, alarmId);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(SavrivoNotifications.stableId(notificationNamespace(context), alarmId));
        Log.i(TAG, "ALARM_PAUSE_REQUESTED alarmId=" + alarmId);
        Intent intent = new Intent(context, OrderAlarmService.class)
                .setAction(ACTION_PAUSE)
                .putExtra(EXTRA_ALARM_ID, alarmId);
        try { context.startService(intent); }
        catch (Exception ignored) {
            // Stored state and the notification were already cleared above.
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        SavrivoNotifications.createChannels(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        pruneExpiredAlarms();
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        String alarmId = intent == null ? "" : intent.getStringExtra(EXTRA_ALARM_ID);
        if (ACTION_PAUSE.equals(action)) {
            pauseOne(alarmId);
            return activeCount() == 0 ? START_NOT_STICKY : START_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            stopOne(alarmId);
            return activeCount() == 0 ? START_NOT_STICKY : START_STICKY;
        }
        if (ACTION_START.equals(action) && validAlarmId(alarmId)) {
            long issuedAt = intent.getLongExtra(EXTRA_ISSUED_AT, 0L);
            long expiresAt = intent.getLongExtra(EXTRA_EXPIRES_AT, 0L);
            if (expiresAt > 0L && expiresAt <= System.currentTimeMillis()) {
                pauseOne(alarmId);
                Log.i(TAG, "EXPIRED_ALARM_START_IGNORED alarmId=" + alarmId);
                return activeCount() == 0 ? START_NOT_STICKY : START_STICKY;
            }
            if (wasAuthoritativelyStopped(this, alarmId, issuedAt)) {
                Log.i(TAG, "STALE_ALARM_START_IGNORED alarmId=" + alarmId);
                return activeCount() == 0 ? START_NOT_STICKY : START_STICKY;
            }
            JSONObject record = new JSONObject();
            try {
                record.put("title", defaultText(intent.getStringExtra(EXTRA_TITLE), "New Scraveit order"));
                record.put("body", defaultText(intent.getStringExtra(EXTRA_BODY), "Open the restaurant app to respond."));
                record.put("orderId", defaultText(intent.getStringExtra(EXTRA_ORDER_ID), ""));
                record.put("startedAt", System.currentTimeMillis());
                record.put("expiresAt", expiresAt);
                putStored(alarmId, record);
                Log.i(TAG, "ALARM_STARTED alarmId=" + alarmId);
            } catch (Exception ignored) { }
        }
        JSONObject alarms = pruneExpiredAlarms();
        if (alarms.length() == 0) {
            stopAll();
            return START_NOT_STICKY;
        }
        showNotifications(alarms);
        beginSoundAndVibration();
        if (isRider()) armPlaybackWatchdog();
        return START_STICKY;
    }

    @SuppressLint("ForegroundServiceType")
    private void showNotifications(JSONObject alarms) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        Iterator<String> ids = alarms.keys();
        String firstId = ids.hasNext() ? ids.next() : "new-order";
        JSONObject first = alarms.optJSONObject(firstId);
        boolean rider = "rider".equals(SavrivoFirebase.appRole(this));
        Notification foreground = notification(
                alarms.length() == 1 ? text(first, "title", rider ? "New delivery offer" : "New Scraveit order")
                        : alarms.length() + (rider ? " delivery offers need action" : " Scraveit orders need action"),
                alarms.length() == 1 ? text(first, "body", rider ? "Accept or decline this delivery." : "Accept or reject this order.")
                        : (rider ? "Open Scraveit Partner to accept or decline each offer."
                                : "Open the restaurant app to accept or reject each order."),
                firstId,
                true);
        startForeground(FOREGROUND_ID, foreground);

        Iterator<String> each = alarms.keys();
        while (each.hasNext()) {
            String alarmId = each.next();
            JSONObject record = alarms.optJSONObject(alarmId);
            manager.notify(SavrivoNotifications.stableId(notificationNamespace(this), alarmId),
                    notification(text(record, "title", rider ? "New delivery offer" : "New Scraveit order"),
                            text(record, "body", rider ? "Accept or decline this delivery." : "Accept or reject this order."), alarmId, true));
        }
    }

    private Notification notification(String title, String body, String alarmId, boolean ongoing) {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) launch = new Intent();
        launch.setPackage(getPackageName());
        launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(
                this, SavrivoNotifications.stableId(notificationNamespace(this) + "-open", alarmId), launch, flags);
        String channel = "rider".equals(SavrivoFirebase.appRole(this))
                ? SavrivoNotifications.RIDER_OFFERS : SavrivoNotifications.RESTAURANT_ORDERS;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, channel)
                : new Notification.Builder(this);
        builder.setSmallIcon(SavrivoNotifications.notificationIcon(this))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_ALARM)
                .setPriority(Notification.PRIORITY_MAX)
                .setOngoing(ongoing)
                .setAutoCancel(false)
                .setContentIntent(pending);
        return builder.build();
    }

    @SuppressWarnings("MissingPermission")
    private void beginSoundAndVibration() {
        if (alarmPlayer == null) {
            try {
                int soundId = getResources().getIdentifier(
                        "savrivo_action_alert", "raw", getPackageName());
                if (soundId == 0) throw new IllegalStateException("Missing Savrivo action alert audio");
                AssetFileDescriptor descriptor = getResources().openRawResourceFd(soundId);
                if (descriptor == null) throw new IllegalStateException("Unreadable Savrivo action alert audio");
                MediaPlayer player = new MediaPlayer();
                player.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                if (isRider()) {
                    player.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
                    player.setVolume(1.0f, 1.0f);
                }
                player.setDataSource(descriptor.getFileDescriptor(),
                        descriptor.getStartOffset(), descriptor.getLength());
                descriptor.close();
                player.setLooping(true);
                if (isRider()) {
                    player.setOnErrorListener((failed, what, extra) -> {
                        Log.e(TAG, "ALARM_PLAYBACK_FAILED what=" + what + " extra=" + extra);
                        if (alarmPlayer == failed) alarmPlayer = null;
                        try { failed.release(); } catch (Exception ignored) { }
                        playbackHandler.postDelayed(() -> {
                            JSONObject active = pruneExpiredAlarms();
                            if (active.length() > 0) beginSoundAndVibration();
                            else stopAll();
                        }, 250L);
                        return true;
                    });
                }
                player.prepare();
                player.start();
                alarmPlayer = player;
                Log.i(TAG, "ALARM_PLAYBACK_CONFIRMED");
            } catch (Exception error) {
                Log.e(TAG, "CUSTOM_ALERT_AUDIO_FAILED", error);
                if (alarmPlayer != null) {
                    try { alarmPlayer.release(); } catch (Exception ignored) { }
                    alarmPlayer = null;
                }
            }
        }
        if (vibrator == null) vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator != null && vibrator.hasVibrator()) {
            long[] pattern = new long[]{0, 500, 350, 500, 1_500};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            } else {
                vibrator.vibrate(pattern, 0);
            }
        }
    }

    private void stopOne(String alarmId) {
        if (!validAlarmId(alarmId)) return;
        markAuthoritativelyStopped(this, alarmId);
        removeStored(this, alarmId);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(SavrivoNotifications.stableId(notificationNamespace(this), alarmId));
        JSONObject remaining = pruneExpiredAlarms();
        if (remaining.length() == 0) stopAll();
        else showNotifications(remaining);
        Log.i(TAG, "ALARM_STOPPED alarmId=" + alarmId);
    }

    private void pauseOne(String alarmId) {
        if (!validAlarmId(alarmId)) return;
        removeStored(this, alarmId);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(SavrivoNotifications.stableId(notificationNamespace(this), alarmId));
        JSONObject remaining = pruneExpiredAlarms();
        if (remaining.length() == 0) stopAll();
        else showNotifications(remaining);
        Log.i(TAG, "ALARM_PAUSED alarmId=" + alarmId);
    }

    private void stopAll() {
        playbackHandler.removeCallbacks(playbackWatchdog);
        releasePlayer();
        if (vibrator != null) vibrator.cancel();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    private void armPlaybackWatchdog() {
        playbackHandler.removeCallbacks(playbackWatchdog);
        playbackHandler.postDelayed(playbackWatchdog, PLAYBACK_WATCHDOG_MS);
    }

    private boolean isRider() {
        return "rider".equals(SavrivoFirebase.appRole(this));
    }

    private static boolean safeIsPlaying(MediaPlayer player) {
        try { return player.isPlaying(); }
        catch (Exception ignored) { return false; }
    }

    private void releasePlayer() {
        if (alarmPlayer == null) return;
        try { alarmPlayer.stop(); } catch (Exception ignored) { }
        try { alarmPlayer.release(); } catch (Exception ignored) { }
        alarmPlayer = null;
    }

    private int activeCount() { return pruneExpiredAlarms().length(); }

    private JSONObject stored() {
        String raw = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_ALARMS, "{}");
        try { return new JSONObject(raw == null ? "{}" : raw); }
        catch (Exception ignored) { return new JSONObject(); }
    }

    private JSONObject pruneExpiredAlarms() {
        JSONObject values = stored();
        long now = System.currentTimeMillis();
        boolean changed = false;
        NotificationManager manager = getSystemService(NotificationManager.class);
        Iterator<String> keys = values.keys();
        while (keys.hasNext()) {
            String alarmId = keys.next();
            JSONObject record = values.optJSONObject(alarmId);
            long expiresAt = record == null ? 0L : record.optLong("expiresAt", 0L);
            boolean unmigratedRiderOffer = isRider() && alarmId.startsWith("rider-offer:")
                    && expiresAt <= 0L;
            if ((expiresAt > 0L && expiresAt <= now) || unmigratedRiderOffer) {
                keys.remove();
                changed = true;
                if (manager != null) {
                    manager.cancel(SavrivoNotifications.stableId(notificationNamespace(this), alarmId));
                }
                Log.i(TAG, "EXPIRED_ALARM_PRUNED alarmId=" + alarmId);
            }
        }
        if (changed) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_ALARMS, values.toString()).apply();
        }
        return values;
    }

    private void putStored(String alarmId, JSONObject record) {
        JSONObject values = stored();
        try { values.put(alarmId, record); }
        catch (Exception ignored) { }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_ALARMS, values.toString()).apply();
    }

    private static void removeStored(Context context, String alarmId) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        try {
            JSONObject values = new JSONObject(preferences.getString(KEY_ALARMS, "{}"));
            values.remove(alarmId);
            preferences.edit().putString(KEY_ALARMS, values.toString()).apply();
        } catch (Exception ignored) {
            preferences.edit().remove(KEY_ALARMS).apply();
        }
    }

    private static boolean wasAuthoritativelyStopped(Context context, String alarmId, long issuedAt) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        long now = System.currentTimeMillis();
        try {
            JSONObject stopped = new JSONObject(preferences.getString(KEY_STOPPED, "{}"));
            long stoppedAt = stopped.optLong(alarmId, 0L);
            boolean blocked = now - stoppedAt <= STOP_TOMBSTONE_MS
                    && (issuedAt <= 0L || issuedAt <= stoppedAt);
            if (!blocked && issuedAt > stoppedAt) stopped.remove(alarmId);
            pruneStopped(preferences, stopped, now);
            return blocked;
        } catch (Exception ignored) {
            preferences.edit().remove(KEY_STOPPED).apply();
            return false;
        }
    }

    private static void markAuthoritativelyStopped(Context context, String alarmId) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        long now = System.currentTimeMillis();
        try {
            JSONObject stopped = new JSONObject(preferences.getString(KEY_STOPPED, "{}"));
            stopped.put(alarmId, now);
            pruneStopped(preferences, stopped, now);
        } catch (Exception ignored) {
            preferences.edit().remove(KEY_STOPPED).apply();
        }
    }

    private static void pruneStopped(SharedPreferences preferences, JSONObject stopped, long now) {
        Iterator<String> keys = stopped.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (now - stopped.optLong(key, 0L) > STOP_TOMBSTONE_MS) keys.remove();
        }
        preferences.edit().putString(KEY_STOPPED, stopped.toString()).apply();
    }

    private static boolean validAlarmId(String value) {
        return value != null && value.length() >= 1 && value.length() <= 180
                && value.matches("[A-Za-z0-9_.:-]+");
    }

    private static String notificationNamespace(Context context) {
        return "rider".equals(SavrivoFirebase.appRole(context)) ? "rider-offer" : "restaurant";
    }

    private static String trim(String value, int max) {
        String safe = value == null ? "" : value.trim();
        return safe.length() <= max ? safe : safe.substring(0, max);
    }

    private static String defaultText(String value, String fallback) {
        String safe = value == null ? "" : value.trim();
        return safe.isEmpty() ? fallback : safe;
    }

    private static String text(JSONObject object, String key, String fallback) {
        return object == null ? fallback : defaultText(object.optString(key), fallback);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        stopAll();
        super.onDestroy();
    }
}
