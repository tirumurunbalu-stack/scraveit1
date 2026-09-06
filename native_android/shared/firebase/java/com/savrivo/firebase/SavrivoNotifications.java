package com.savrivo.firebase;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

public final class SavrivoNotifications {
    public static final String RESTAURANT_ORDERS = "restaurant_new_orders";
    // A new channel is intentional: Android persists the old channel's sound settings across
    // upgrades, so correcting a muted/short-lived legacy channel requires a new stable ID.
    public static final String RIDER_OFFERS = "rider_offers_v4";
    public static final String ORDER_STATUS = "savrivo_order_status";

    private SavrivoNotifications() { }

    public static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel restaurant = new NotificationChannel(
                RESTAURANT_ORDERS, "New restaurant orders", NotificationManager.IMPORTANCE_HIGH);
        restaurant.setDescription("Persistent alerts for orders waiting for restaurant action");
        restaurant.enableVibration(true);
        // OrderAlarmService owns the repeating sound so STOP_ORDER_ALARM can stop one alarm exactly.
        restaurant.setSound(null, null);
        manager.createNotificationChannel(restaurant);

        NotificationChannel rider = new NotificationChannel(
                RIDER_OFFERS, "Delivery offers", NotificationManager.IMPORTANCE_HIGH);
        rider.setDescription("Time-limited delivery offers assigned to this partner");
        rider.enableVibration(true);
        int riderSound = context.getResources().getIdentifier(
                "savrivo_action_alert", "raw", context.getPackageName());
        if (riderSound != 0) {
            Uri sound = Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://"
                    + context.getPackageName() + "/" + riderSound);
            AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            rider.setSound(sound, attributes);
        }
        manager.createNotificationChannel(rider);

        NotificationChannel status = new NotificationChannel(
                ORDER_STATUS, "Order status", NotificationManager.IMPORTANCE_DEFAULT);
        status.setDescription("Live order progress updates");
        manager.createNotificationChannel(status);
    }

    public static int notificationIcon(Context context) {
        try {
            ApplicationInfo info = context.getPackageManager().getApplicationInfo(
                    context.getPackageName(), PackageManager.GET_META_DATA);
            int configured = info.metaData == null ? 0 : info.metaData.getInt(
                    "com.google.firebase.messaging.default_notification_icon", 0);
            if (configured != 0) return configured;
        } catch (Exception ignored) { }
        int icon = context.getResources().getIdentifier(
                "savrivo_notification", "drawable", context.getPackageName());
        if (icon == 0) {
            icon = context.getResources().getIdentifier(
                    "savrivo_partner_notification", "drawable", context.getPackageName());
        }
        if (icon == 0) icon = context.getApplicationInfo().icon;
        return icon == 0 ? android.R.drawable.ic_dialog_info : icon;
    }

    public static int stableId(String namespace, String value) {
        int hash = (namespace + ":" + (value == null ? "" : value)).hashCode();
        return 0x30000000 | (hash & 0x0fffffff);
    }
}
