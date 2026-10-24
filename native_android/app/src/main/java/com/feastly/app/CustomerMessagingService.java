package com.feastly.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.util.Map;

/** Receives Customer order updates and FCM installation-token changes. */
public final class CustomerMessagingService extends FirebaseMessagingService {
  static final String ORDER_CHANNEL = "customer_orders";
  static final String PROMOTIONS_CHANNEL = "customer_promotions";
  // Its own channel so it pops up on screen like an order update (Offers is quieter).
  static final String REMINDERS_CHANNEL = "customer_reminders";
  // Friends calling: rings with the phone's ringtone until answered, declined or the caller hangs up.
  static final String CALLS_CHANNEL = "customer_calls";
  static final String PUSH_ACTION = "com.feastly.app.CUSTOMER_PUSH_EVENT";
  static final String EXTRA_PUSH_JSON = "savrivo_push_json";
  private static final String PREFS = "savrivo_customer_push_events_v1";
  private static final String PENDING_EVENT = "pending_event";

  @Override public void onNewToken(String token) {
    super.onNewToken(token);
    PushTokenStore.save(this, token);
    JSONObject event = new JSONObject();
    try { event.put("type", "TOKEN_REFRESH"); }
    catch (Exception ignored) { }
    publishToRunningApp(this, event);
  }

  @Override public void onMessageReceived(RemoteMessage message) {
    super.onMessageReceived(message);
    JSONObject event = eventJson(message);
    storePendingEvent(this, event);
    publishToRunningApp(this, event);

    String type = event.optString("type", "");
    if ("ORDER_STATUS".equals(type)) {
      String title = event.optString("title", "Scraveit order update");
      String body = event.optString("body", "Your order has an update.");
      showOrderNotification(event, title, body);
    } else if ("CALL_INCOMING".equals(type)) {
      // With the app open, the page shows its own full-screen call.
      if (!MainActivity.isVisible()) showCallNotification(event);
    } else if ("CALL_ENDED".equals(type)) {
      NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
      if (manager != null) manager.cancel(callNotificationId(event.optString("callId", "")));
      if ("1".equals(event.optString("missed", "0"))) showMissedCall(event);
    } else if ("CUSTOMER_BROADCAST".equals(type)) {
      String title = event.optString("title", "Scraveit");
      String body = event.optString("body", "");
      showBroadcastNotification(event, title, body);
    }
  }

  @Override public void onDeletedMessages() {
    JSONObject event = new JSONObject();
    try { event.put("type", "FCM_MESSAGES_DELETED"); }
    catch (Exception ignored) { }
    storePendingEvent(this, event);
    publishToRunningApp(this, event);
  }

  static void createNotificationChannels(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationChannel channel = new NotificationChannel(
        ORDER_CHANNEL, "Order updates", NotificationManager.IMPORTANCE_HIGH);
    channel.setDescription("Order confirmation, preparation and delivery updates");
    channel.enableVibration(true);
    NotificationChannel promotions = new NotificationChannel(
        PROMOTIONS_CHANNEL, "Offers and announcements", NotificationManager.IMPORTANCE_DEFAULT);
    promotions.setDescription("Scheduled offers and announcements from Scraveit");
    NotificationChannel reminders = new NotificationChannel(
        REMINDERS_CHANNEL, "Cart reminders and meal ideas", NotificationManager.IMPORTANCE_HIGH);
    reminders.setDescription("A reminder about food left in your cart, and ideas at breakfast, lunch and dinner");
    NotificationChannel calls = new NotificationChannel(
        CALLS_CHANNEL, "Calls from friends", NotificationManager.IMPORTANCE_HIGH);
    calls.setDescription("Voice and video calls from your Scraveit friends");
    calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
    calls.enableVibration(true);
    calls.setVibrationPattern(new long[]{0, 900, 700, 900, 700, 900});
    calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    if (manager != null) {
      manager.createNotificationChannel(channel);
      manager.createNotificationChannel(calls);
      manager.createNotificationChannel(promotions);
      manager.createNotificationChannel(reminders);
    }
  }

  static JSONObject consumePendingEvent(Context context) {
    SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    String raw = preferences.getString(PENDING_EVENT, "");
    if (raw == null || raw.length() == 0) return null;
    preferences.edit().remove(PENDING_EVENT).apply();
    try { return new JSONObject(raw); }
    catch (Exception ignored) { return null; }
  }

  static JSONObject eventFromIntent(Intent intent) {
    if (intent == null) return null;
    String raw = intent.getStringExtra(EXTRA_PUSH_JSON);
    if (raw != null && raw.length() > 0) {
      try {
        JSONObject value = new JSONObject(raw);
        value.put("openedFromNotification", true);
        return value;
      } catch (Exception ignored) { }
    }
    String type = intent.getStringExtra("type");
    String orderId = intent.getStringExtra("orderId");
    if ((type == null || type.length() == 0) && (orderId == null || orderId.length() == 0)) return null;
    JSONObject value = new JSONObject();
    try {
      if (type != null) value.put("type", type);
      if (orderId != null) value.put("orderId", orderId);
      String status = intent.getStringExtra("status");
      if (status != null) value.put("status", status);
      value.put("openedFromNotification", true);
    } catch (Exception ignored) { }
    return value;
  }

  private JSONObject eventJson(RemoteMessage message) {
    JSONObject event = new JSONObject();
    try {
      for (Map.Entry<String, String> entry : message.getData().entrySet()) {
        event.put(entry.getKey(), entry.getValue());
      }
      RemoteMessage.Notification notification = message.getNotification();
      if (notification != null) {
        if (notification.getTitle() != null) event.put("title", notification.getTitle());
        if (notification.getBody() != null) event.put("body", notification.getBody());
      }
      if (message.getMessageId() != null) event.put("messageId", message.getMessageId());
      event.put("receivedAt", System.currentTimeMillis());
    } catch (Exception ignored) { }
    return event;
  }

  private void showOrderNotification(JSONObject event, String title, String body) {
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    createNotificationChannels(this);
    String orderId = event.optString("orderId", "order");
    int notificationId = 0x5A000000 | (orderId.hashCode() & 0x00ffffff);
    Intent launch = new Intent(this, MainActivity.class)
        .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(EXTRA_PUSH_JSON, event.toString());
    PendingIntent pending = PendingIntent.getActivity(this, notificationId, launch,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, ORDER_CHANNEL) : new Notification.Builder(this);
    builder.setSmallIcon(R.drawable.savrivo_notification)
        .setColor(getColor(R.color.savrivo_primary))
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new Notification.BigTextStyle().bigText(body))
        .setCategory(Notification.CATEGORY_STATUS)
        .setPriority(Notification.PRIORITY_HIGH)
        .setOnlyAlertOnce(true)
        .setAutoCancel(true)
        .setContentIntent(pending);
    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(notificationId, builder.build());
  }

  private void showBroadcastNotification(JSONObject event, String title, String body) {
    if (body.length() == 0) return;
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    createNotificationChannels(this);
    String broadcastId = event.optString("broadcastId", "broadcast");
    int notificationId = 0x5B000000 | (broadcastId.hashCode() & 0x00ffffff);
    Intent launch = new Intent(this, MainActivity.class)
        .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(EXTRA_PUSH_JSON, event.toString());
    PendingIntent pending = PendingIntent.getActivity(this, notificationId, launch,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, PROMOTIONS_CHANNEL) : new Notification.Builder(this);
    builder.setSmallIcon(R.drawable.savrivo_notification)
        .setColor(getColor(R.color.savrivo_primary))
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new Notification.BigTextStyle().bigText(body))
        .setCategory(Notification.CATEGORY_PROMO)
        .setAutoCancel(true)
        .setContentIntent(pending);
    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(notificationId, builder.build());
  }

  static int callNotificationId(String callId) {
    return 0x5C000000 | ((callId == null ? 0 : callId.hashCode()) & 0x00ffffff);
  }

  private PendingIntent callIntent(JSONObject event, String action, int requestCode) {
    JSONObject copy = new JSONObject();
    try {
      copy = new JSONObject(event.toString());
      copy.put("callAction", action);
    } catch (Exception ignored) { }
    Intent launch = new Intent(this, MainActivity.class)
        .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(EXTRA_PUSH_JSON, copy.toString());
    return PendingIntent.getActivity(this, requestCode, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  /** "Padhu is calling…" with Decline and Answer; keeps ringing until one is tapped or the call stops. */
  private void showCallNotification(JSONObject event) {
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    createNotificationChannels(this);
    String callId = event.optString("callId", "");
    if (callId.isEmpty()) return;
    int id = callNotificationId(callId);
    boolean video = "video".equals(event.optString("kind", "audio"));
    String name = event.optString("fromName", "A friend");
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CALLS_CHANNEL) : new Notification.Builder(this);
    builder.setSmallIcon(R.drawable.savrivo_notification)
        .setColor(getColor(R.color.savrivo_primary))
        .setContentTitle(name)
        .setContentText(video ? "Incoming video call" : "Incoming voice call")
        .setCategory(Notification.CATEGORY_CALL)
        .setPriority(Notification.PRIORITY_MAX)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(true)
        .setContentIntent(callIntent(event, "open", id))
        .addAction(new Notification.Action.Builder(null, "Decline", callIntent(event, "decline", id + 1)).build())
        .addAction(new Notification.Action.Builder(null, video ? "Answer video" : "Answer", callIntent(event, "answer", id + 2)).build());
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) builder.setTimeoutAfter(45_000);
    Notification notification = builder.build();
    notification.flags |= Notification.FLAG_INSISTENT;
    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(id, notification);
  }

  private void showMissedCall(JSONObject event) {
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    createNotificationChannels(this);
    String callId = event.optString("callId", "");
    int id = callNotificationId(callId) ^ 0x00800000;
    boolean video = "video".equals(event.optString("kind", "audio"));
    Intent launch = new Intent(this, MainActivity.class)
        .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(EXTRA_PUSH_JSON, event.toString());
    PendingIntent pending = PendingIntent.getActivity(this, id, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, ORDER_CHANNEL) : new Notification.Builder(this);
    builder.setSmallIcon(R.drawable.savrivo_notification)
        .setColor(getColor(R.color.savrivo_primary))
        .setContentTitle(video ? "Missed video call" : "Missed voice call")
        .setContentText(event.optString("fromName", "A friend") + " called you")
        .setCategory(Build.VERSION.SDK_INT >= 30 ? Notification.CATEGORY_MISSED_CALL : Notification.CATEGORY_CALL)
        .setAutoCancel(true)
        .setContentIntent(pending);
    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(id, builder.build());
  }

  private static void storePendingEvent(Context context, JSONObject event) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString(PENDING_EVENT, event.toString()).apply();
  }

  private static void publishToRunningApp(Context context, JSONObject event) {
    Intent intent = new Intent(PUSH_ACTION).setPackage(context.getPackageName())
        .putExtra(EXTRA_PUSH_JSON, event.toString());
    context.sendBroadcast(intent);
  }
}
