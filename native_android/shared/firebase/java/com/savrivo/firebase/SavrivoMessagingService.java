package com.savrivo.firebase;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.util.Map;

public final class SavrivoMessagingService extends FirebaseMessagingService {
    private static final String TAG = "SavrivoMessaging";
    @Override public void onNewToken(String token) {
        JSONObject event = new JSONObject();
        put(event, "type", "PUSH_TOKEN_REFRESH");
        put(event, "receivedAt", System.currentTimeMillis());
        SavrivoPushStore.dispatch(this, event);
    }

    @Override public void onDeletedMessages() {
        JSONObject event = new JSONObject();
        put(event, "type", "PUSH_RESYNC_REQUIRED");
        put(event, "receivedAt", System.currentTimeMillis());
        SavrivoPushStore.dispatch(this, event);
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        SavrivoNotifications.createChannels(this);
        JSONObject event = new JSONObject();
        for (Map.Entry<String, String> entry : message.getData().entrySet()) {
            put(event, trim(entry.getKey(), 100), trim(entry.getValue(), 2_000));
        }
        RemoteMessage.Notification notification = message.getNotification();
        if (notification != null) {
            if (!event.has("title")) put(event, "title", trim(notification.getTitle(), 120));
            if (!event.has("body")) put(event, "body", trim(notification.getBody(), 300));
        }
        put(event, "receivedAt", System.currentTimeMillis());
        String type = event.optString("type");
        String role = SavrivoFirebase.appRole(this);
        String orderId = event.optString("orderId");

        if ("RESTAURANT_NEW_ORDER".equals(type) && "restaurant".equals(role)
                && "Order placed".equals(event.optString("status"))) {
            String alarmId = event.optString("alarmId", "order:" + orderId);
            Log.i(TAG, "NEW_ORDER_PUSH_RECEIVED orderId=" + orderId);
            OrderAlarmService.start(this, alarmId,
                    event.optString("title", "New Scraveit order"),
                    event.optString("body", "A new order is waiting for your response."), orderId);
        } else if ("STOP_ORDER_ALARM".equals(type) && "restaurant".equals(role)) {
            String alarmId = event.optString("alarmId", "order:" + orderId);
            OrderAlarmService.stop(this, alarmId);
            SavrivoPushStore.removeRestaurantNewOrder(this, orderId);
            Log.i(TAG, "STOP_ORDER_ALARM_RECEIVED orderId=" + orderId);
        } else if ("RIDER_ORDER_OFFER".equals(type) && "rider".equals(role)) {
            long expiresAt = longValue(event.optString("expiresAt"));
            if (expiresAt <= 0 || expiresAt > System.currentTimeMillis()) {
                String offerId = event.optString("offerId", "rider-offer:" + orderId);
                boolean alarmStarted = OrderAlarmService.start(this, offerId,
                        event.optString("title", "New delivery offer"),
                        event.optString("body", "Accept or decline this nearby delivery."), orderId,
                        longValue(event.optString("offeredAt")), expiresAt);
                if (!alarmStarted) {
                    showNotification(event, SavrivoNotifications.RIDER_OFFERS,
                            "New delivery offer", "Accept or decline this nearby delivery.",
                            true, expiresAt);
                }
            }
        } else if ("REMOVE_RIDER_OFFER".equals(type) && "rider".equals(role)) {
            String offerId = event.optString("offerId", "rider-offer:" + orderId);
            OrderAlarmService.stop(this, offerId);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.cancel(SavrivoNotifications.stableId("rider-offer", orderId));
                manager.cancel("rider_offer_" + orderId, 0);
            }
            SavrivoPushStore.removeRiderOffer(this, orderId);
        } else if ("ORDER_STATUS".equals(type)) {
            showNotification(event, SavrivoNotifications.ORDER_STATUS,
                    "Order updated", event.optString("status", "Open Scraveit for details."), false, 0);
        }
        SavrivoPushStore.dispatch(this, event);
    }

    private void showNotification(
            JSONObject event, String channelId, String fallbackTitle, String fallbackBody,
            boolean offer, long expiresAt) {
        String orderId = event.optString("orderId", "unknown");
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) launch = new Intent();
        launch.setPackage(getPackageName());
        launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        launch.putExtra(SavrivoPushStore.EXTRA_EVENT, event.toString());
        int id = SavrivoNotifications.stableId(offer ? "rider-offer" : "order-status", orderId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, id, launch, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, channelId) : new Notification.Builder(this);
        String title = defaultText(event.optString("title"), fallbackTitle);
        String body = defaultText(event.optString("body"), fallbackBody);
        builder.setSmallIcon(SavrivoNotifications.notificationIcon(this))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setCategory(offer ? Notification.CATEGORY_CALL : Notification.CATEGORY_STATUS)
                .setPriority(offer ? Notification.PRIORITY_MAX : Notification.PRIORITY_DEFAULT)
                .setOnlyAlertOnce(false);
        if (offer && expiresAt > System.currentTimeMillis() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setTimeoutAfter(expiresAt - System.currentTimeMillis());
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(id, builder.build());
    }

    private static void put(JSONObject object, String key, Object value) {
        if (key == null || key.isEmpty()) return;
        try { object.put(key, value == null ? "" : value); }
        catch (Exception ignored) { }
    }

    private static String trim(String value, int max) {
        String safe = value == null ? "" : value.trim();
        return safe.length() <= max ? safe : safe.substring(0, max);
    }

    private static String defaultText(String value, String fallback) {
        String safe = value == null ? "" : value.trim();
        return safe.isEmpty() ? fallback : safe;
    }

    private static long longValue(String value) {
        try { return Long.parseLong(value); }
        catch (Exception ignored) { return 0; }
    }
}
