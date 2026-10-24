package com.feastly.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Calendar;

/**
 * "You left something in your cart": shown by the phone itself about 5 seconds
 * after the customer leaves the app with items in the cart (the page decides
 * whether one is due; see savrivoCartNudge in premium.js). Cancelled the
 * moment they come back, never more than one in 20 hours, and never between
 * 10 pm and 8 am.
 */
public final class CartNudge extends BroadcastReceiver {
  private static final String PREFS = "savrivo_cart_nudge_v1";
  private static final String PENDING = "pending";
  private static final String LAST_SHOWN = "last_shown_at";
  private static final long MIN_GAP = 20L * 60 * 60 * 1000;
  private static final int NOTIFICATION_ID = 0x5C000001;
  private static final int REQUEST_CODE = 0x5C01;

  static void schedule(Context context, String payloadJson) {
    final JSONObject payload;
    try { payload = new JSONObject(payloadJson); }
    catch (Exception ignored) { return; }
    long delay = Math.max(3_000L, Math.min(30L * 60 * 1000, payload.optLong("delayMs", 5_000L)));
    SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    if (System.currentTimeMillis() - prefs.getLong(LAST_SHOWN, 0L) < MIN_GAP) return;
    prefs.edit().putString(PENDING, payload.toString()).apply();
    final File image = imageFile(context);
    image.delete();
    final String imageUrl = payload.optString("image", "");
    if (imageUrl.startsWith("https://")) new Thread(() -> download(imageUrl, image)).start();
    AlarmManager alarms = context.getSystemService(AlarmManager.class);
    if (alarms == null) return;
    long at = System.currentTimeMillis() + delay;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(context));
    else alarms.set(AlarmManager.RTC_WAKEUP, at, pending(context));
  }

  static void cancel(Context context) {
    SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    if (!prefs.contains(PENDING)) return;
    prefs.edit().remove(PENDING).apply();
    AlarmManager alarms = context.getSystemService(AlarmManager.class);
    if (alarms != null) alarms.cancel(pending(context));
  }

  @Override public void onReceive(Context context, Intent intent) {
    SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    String raw = prefs.getString(PENDING, "");
    prefs.edit().remove(PENDING).apply();
    if (raw == null || raw.length() == 0) return;
    int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
    if (hour < 8 || hour >= 22) return;
    if (System.currentTimeMillis() - prefs.getLong(LAST_SHOWN, 0L) < MIN_GAP) return;
    if (Build.VERSION.SDK_INT >= 33
        && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    JSONObject payload;
    try { payload = new JSONObject(raw); }
    catch (Exception ignored) { return; }
    String title = payload.optString("title", ""), body = payload.optString("body", "");
    if (title.length() == 0 || body.length() == 0) return;

    CustomerMessagingService.createNotificationChannels(context);
    JSONObject event = new JSONObject();
    try { event.put("type", "CART_REMINDER").put("route", "cart"); }
    catch (Exception ignored) { }
    Intent launch = new Intent(context, MainActivity.class)
        .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(CustomerMessagingService.EXTRA_PUSH_JSON, event.toString());
    PendingIntent open = PendingIntent.getActivity(context, NOTIFICATION_ID, launch,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(context, CustomerMessagingService.REMINDERS_CHANNEL) : new Notification.Builder(context);
    builder.setSmallIcon(R.drawable.savrivo_notification)
        .setColor(context.getColor(R.color.savrivo_primary))
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new Notification.BigTextStyle().bigText(body))
        .setCategory(Notification.CATEGORY_REMINDER)
        .setPriority(Notification.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(open);
    Bitmap picture = loadImage(imageFile(context));
    if (picture != null) builder.setLargeIcon(picture);
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    if (manager == null) return;
    manager.notify(NOTIFICATION_ID, builder.build());
    prefs.edit().putLong(LAST_SHOWN, System.currentTimeMillis()).apply();
  }

  private static PendingIntent pending(Context context) {
    Intent intent = new Intent(context, CartNudge.class);
    return PendingIntent.getBroadcast(context, REQUEST_CODE, intent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private static File imageFile(Context context) { return new File(context.getCacheDir(), "cart_nudge_image"); }

  /** The dish photo for the notification, fetched while the app is still awake. At most 2 MB. */
  private static void download(String url, File target) {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(url).openConnection();
      connection.setConnectTimeout(6000);
      connection.setReadTimeout(8000);
      if (connection.getResponseCode() != 200) return;
      File partial = new File(target.getPath() + ".part");
      try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(partial)) {
        byte[] buffer = new byte[16 * 1024];
        int total = 0, read;
        while ((read = in.read(buffer)) > 0) {
          total += read;
          if (total > 2 * 1024 * 1024) { out.close(); partial.delete(); return; }
          out.write(buffer, 0, read);
        }
      }
      if (!partial.renameTo(target)) partial.delete();
    } catch (Exception ignored) {
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private static Bitmap loadImage(File file) {
    if (!file.exists()) return null;
    try {
      BitmapFactory.Options bounds = new BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      BitmapFactory.decodeFile(file.getPath(), bounds);
      int sample = 1;
      while (bounds.outWidth / (sample * 2) >= 256 && bounds.outHeight / (sample * 2) >= 256) sample *= 2;
      BitmapFactory.Options options = new BitmapFactory.Options();
      options.inSampleSize = sample;
      return BitmapFactory.decodeFile(file.getPath(), options);
    } catch (Exception ignored) {
      return null;
    }
  }
}
