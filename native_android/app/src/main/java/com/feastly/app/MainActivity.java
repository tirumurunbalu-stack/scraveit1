package com.feastly.app;

import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Notification;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;

import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import com.google.firebase.crashlytics.FirebaseCrashlytics;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends ComponentActivity {
  private static final int LOCATION_REQUEST = 4401;
  private static final int NOTIFICATION_REQUEST = 4403;
  private static final String ORDER_CHANNEL = CustomerMessagingService.ORDER_CHANNEL;
  private static final String TRUSTED_HOST = "appassets.androidplatform.net";
  private static final String TRUSTED_ORIGIN = "https://" + TRUSTED_HOST + "/assets/";
  private static final String TRUSTED_PAGE = TRUSTED_ORIGIN + "premium.html";
  private final Handler handler = new Handler(Looper.getMainLooper());
  private long openedAt;
  private long lastBackPressed;
  private WebView webView;
  private LocationManager activeLocationManager;
  private LocationListener activeLocationListener;
  private boolean retryLocationOnResume;
  private CredentialManager credentialManager;
  private final ExecutorService credentialExecutor = Executors.newSingleThreadExecutor();
  private CancellationSignal googleSignInCancellation;
  private boolean googleSignInInFlight;
  private FirebaseCallableClient callableClient;
  private SecureOrderStore secureOrderStore;
  private JSONObject pendingPushEvent;
  private boolean pushReceiverRegistered;
  private final BroadcastReceiver pushReceiver = new BroadcastReceiver() {
    @Override public void onReceive(Context context, Intent intent) {
      String raw = intent == null ? null : intent.getStringExtra(CustomerMessagingService.EXTRA_PUSH_JSON);
      try { if (raw != null) queuePushEvent(new JSONObject(raw)); }
      catch (Exception error) { FirebaseCrashlytics.getInstance().recordException(error); }
    }
  };
  private final Runnable locationTimeout = new Runnable() {
    @Override public void run() {
      stopLocationUpdates();
      publishLocationUnavailable();
    }
  };

  @SuppressLint("SetJavaScriptEnabled")
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    openedAt = System.currentTimeMillis();
    callableClient = new FirebaseCallableClient();
    secureOrderStore = new SecureOrderStore(this);
    JSONObject launchedFromPush = CustomerMessagingService.eventFromIntent(getIntent());
    JSONObject storedPush = CustomerMessagingService.consumePendingEvent(this);
    pendingPushEvent = launchedFromPush != null ? launchedFromPush : storedPush;
    credentialManager = CredentialManager.create(this);
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override public void handleOnBackPressed() {
        handleBackRequest();
      }
    });
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

    final FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.rgb(246, 249, 253));

    final WebView view = new WebView(this);
    webView = view;
    view.setVisibility(View.INVISIBLE);
    view.setVerticalScrollBarEnabled(false);
    view.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
    view.setNestedScrollingEnabled(true);
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setCacheMode(WebSettings.LOAD_DEFAULT);
    settings.setGeolocationEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setSupportMultipleWindows(false);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setSaveFormData(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      settings.setSafeBrowsingEnabled(true);
    }
    settings.setDefaultTextEncodingName("UTF-8");
    WebView.setWebContentsDebuggingEnabled(false);
    view.removeJavascriptInterface("searchBoxJavaBridge_");
    view.removeJavascriptInterface("accessibility");
    view.removeJavascriptInterface("accessibilityTraversal");
    view.setWebChromeClient(new WebChromeClient());
    view.addJavascriptInterface(new NativeBridge(), "FeastlyNative");
    createOrderNotificationChannel();
    final FrameLayout splash = new FrameLayout(this);
    view.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView webView, String url) {
        return handleNavigation(url);
      }
      @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
        return request == null ? true : handleNavigation(request.getUrl().toString());
      }
      @Override public WebResourceResponse shouldInterceptRequest(WebView ignored, String url) {
        return servePackagedAsset(url == null ? null : Uri.parse(url));
      }
      @Override public WebResourceResponse shouldInterceptRequest(WebView ignored, WebResourceRequest request) {
        return request == null ? null : servePackagedAsset(request.getUrl());
      }
      @Override public void onPageFinished(WebView webView, String url) {
        if (!isTrustedPage(url)) return;
        long remaining = Math.max(0, 850 - (System.currentTimeMillis() - openedAt));
        handler.postDelayed(new Runnable() {
          @Override public void run() {
            if (!isTrustedPageLoaded()) return;
            view.setVisibility(View.VISIBLE);
            splash.setVisibility(View.GONE);
            deliverPendingPushEvent();
          }
        }, remaining);
      }
    });
    view.loadUrl(TRUSTED_PAGE);
    root.addView(view, new FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

    splash.setClickable(false);
    ImageView logo = new ImageView(this);
    logo.setImageResource(com.feastly.app.R.drawable.scraveit_icon);
    logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
    logo.setAlpha(0f);
    logo.setScaleX(0.72f);
    logo.setScaleY(0.72f);
    FrameLayout.LayoutParams logoParams = new FrameLayout.LayoutParams(dp(154), dp(154), Gravity.CENTER);
    logoParams.bottomMargin = dp(56);
    splash.addView(logo, logoParams);

    TextView brand = new TextView(this);
    brand.setText(R.string.splash_brand);
    brand.setTextColor(Color.rgb(20, 99, 216));
    brand.setTextSize(20);
    brand.setGravity(Gravity.CENTER);
    brand.setLetterSpacing(0.16f);
    brand.setAlpha(0f);
    brand.setTranslationY(dp(14));
    FrameLayout.LayoutParams brandParams = new FrameLayout.LayoutParams(dp(260), dp(34), Gravity.CENTER);
    brandParams.topMargin = dp(140);
    splash.addView(brand, brandParams);

    TextView tagline = new TextView(this);
    tagline.setText(R.string.splash_tagline);
    tagline.setTextColor(Color.rgb(74, 119, 164));
    tagline.setTextSize(9);
    tagline.setGravity(Gravity.CENTER);
    tagline.setLetterSpacing(0.08f);
    tagline.setAlpha(0f);
    tagline.setTranslationY(dp(12));
    FrameLayout.LayoutParams tagParams = new FrameLayout.LayoutParams(dp(340), dp(24), Gravity.CENTER);
    tagParams.topMargin = dp(184);
    splash.addView(tagline, tagParams);
    root.addView(splash, new FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    setContentView(root);

    AnimatorSet opening = new AnimatorSet();
    opening.setInterpolator(new DecelerateInterpolator());
    opening.playTogether(
        ObjectAnimator.ofFloat(logo, View.ALPHA, 0f, 1f),
        ObjectAnimator.ofFloat(logo, View.SCALE_X, 0.72f, 1f),
        ObjectAnimator.ofFloat(logo, View.SCALE_Y, 0.72f, 1f),
        ObjectAnimator.ofFloat(brand, View.ALPHA, 0f, 1f),
        ObjectAnimator.ofFloat(brand, View.TRANSLATION_Y, dp(14), 0f),
        ObjectAnimator.ofFloat(tagline, View.ALPHA, 0f, 1f),
        ObjectAnimator.ofFloat(tagline, View.TRANSLATION_Y, dp(12), 0f));
    opening.setStartDelay(70);
    opening.setDuration(510);
    opening.start();
  }

  private int dp(int value) {
    return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
  }

  private boolean handleNavigation(String url) {
    if (isTrustedAssetUrl(url)) return false;
    if (url == null) return true;
    Uri uri;
    try { uri = Uri.parse(url); } catch (Exception ignored) { return true; }
    String scheme = uri.getScheme();
    if (scheme == null) return true;
    if ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)
        || "mailto".equalsIgnoreCase(scheme) || "tel".equalsIgnoreCase(scheme)
        || "geo".equalsIgnoreCase(scheme)) {
      try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
    }
    return true;
  }

  private boolean isTrustedAssetUrl(String url) {
    if (url == null) return false;
    try {
      Uri uri = Uri.parse(url);
      String path = uri.getPath();
      return "https".equalsIgnoreCase(uri.getScheme())
          && TRUSTED_HOST.equalsIgnoreCase(uri.getHost())
          && uri.getPort() == -1
          && path != null && path.startsWith("/assets/");
    } catch (Exception ignored) {
      return false;
    }
  }

  private boolean isTrustedPage(String url) {
    if (!isTrustedAssetUrl(url)) return false;
    try { return "/assets/premium.html".equals(Uri.parse(url).getPath()); }
    catch (Exception ignored) { return false; }
  }

  private boolean isTrustedPageLoaded() {
    return webView != null && isTrustedPage(webView.getUrl());
  }

  private WebResourceResponse servePackagedAsset(Uri uri) {
    if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())
        || !TRUSTED_HOST.equalsIgnoreCase(uri.getHost()) || uri.getPort() != -1) return null;
    String path = uri.getPath();
    if (path == null || !path.startsWith("/assets/")) return blockedAssetResponse();
    String assetPath = path.substring("/assets/".length());
    if (assetPath.length() == 0 || assetPath.contains("..") || assetPath.contains("\\")) {
      return blockedAssetResponse();
    }
    try {
      InputStream stream = getAssets().open(assetPath);
      return new WebResourceResponse(assetMimeType(assetPath), "UTF-8", stream);
    } catch (IOException ignored) {
      return blockedAssetResponse();
    }
  }

  private WebResourceResponse blockedAssetResponse() {
    return new WebResourceResponse("text/plain", "UTF-8",
        new ByteArrayInputStream("Not found".getBytes(StandardCharsets.UTF_8)));
  }

  private String assetMimeType(String path) {
    String lower = path.toLowerCase(Locale.US);
    if (lower.endsWith(".html")) return "text/html";
    if (lower.endsWith(".css")) return "text/css";
    if (lower.endsWith(".js")) return "application/javascript";
    if (lower.endsWith(".json")) return "application/json";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    return "application/octet-stream";
  }

  private void handleBackRequest() {
    if (!isTrustedPageLoaded()) {
      confirmExit();
      return;
    }
    webView.evaluateJavascript(
        "window.handleAndroidBack ? window.handleAndroidBack() : 'root'",
        value -> {
          if (value != null && value.contains("handled")) return;
          confirmExit();
        });
  }

  private void confirmExit() {
    long now = System.currentTimeMillis();
    if (now - lastBackPressed < 2000) {
      finish();
    } else {
      lastBackPressed = now;
      Toast.makeText(this, "Press back again to exit", Toast.LENGTH_SHORT).show();
    }
  }

  private class NativeBridge {
    @JavascriptInterface public void requestCurrentLocation() {
      runOnUiThread(new Runnable() {
        @Override public void run() {
          if (isTrustedPageLoaded()) fetchCurrentLocation();
        }
      });
    }

    @JavascriptInterface public void signInWithGoogle() {
      runOnUiThread(new Runnable() {
        @Override public void run() {
          if (isTrustedPageLoaded()) chooseGoogleAccount();
        }
      });
    }

    @JavascriptInterface public void notifyOrder(String title, String body, int id) {
      runOnUiThread(() -> {
        if (isTrustedPageLoaded()) showOrderNotification(title, body, id);
      });
    }

    @JavascriptInterface public void registerPushToken(String requestId, String firebaseIdToken) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        requestNotificationPermissionIfNeeded();
        FirebaseMessaging.getInstance().getToken()
            .addOnSuccessListener(token -> {
              PushTokenStore.save(MainActivity.this, token);
              JSONObject payload = new JSONObject();
              try {
                payload.put("token", token);
                payload.put("app", "customer");
                payload.put("platform", "android");
                payload.put("appVersion", appVersion());
                payload.put("deviceModel", deviceModel());
              } catch (Exception error) {
                publishNativeFailure(requestId, "registerPushToken", "INVALID_ARGUMENT",
                    "Device registration could not be prepared.");
                return;
              }
              invokeCallable(requestId, "registerPushToken", firebaseIdToken, payload, null);
            })
            .addOnFailureListener(error -> {
              FirebaseCrashlytics.getInstance().recordException(error);
              publishNativeFailure(requestId, "registerPushToken", "PUSH_TOKEN_UNAVAILABLE",
                  "Notifications could not be enabled on this device.");
            });
      });
    }

    @JavascriptInterface public void unregisterPushToken(String requestId, String firebaseIdToken) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        String token = PushTokenStore.read(MainActivity.this);
        if (token.length() < 20) {
          JSONObject result = new JSONObject();
          try { result.put("removed", false); } catch (Exception ignored) { }
          publishNativeSuccess(requestId, "unregisterPushToken", result);
          return;
        }
        JSONObject payload = new JSONObject();
        try { payload.put("token", token); }
        catch (Exception ignored) { }
        invokeCallable(requestId, "unregisterPushToken", firebaseIdToken, payload,
            () -> PushTokenStore.clear(MainActivity.this, token));
      });
    }

    @JavascriptInterface public void createCodOrder(String requestId, String firebaseIdToken,
                                                     String payloadJson) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        try {
          JSONObject payload = new JSONObject(payloadJson == null ? "{}" : payloadJson);
          invokeCallable(requestId, "createCodOrder", firebaseIdToken, payload, null);
        } catch (Exception error) {
          publishNativeFailure(requestId, "createCodOrder", "INVALID_ARGUMENT",
              "The order request is invalid. Refresh the cart and try again.");
        }
      });
    }

    @JavascriptInterface public void createOrder(String requestId, String firebaseIdToken,
                                                 String payloadJson) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        try {
          JSONObject payload = new JSONObject(payloadJson == null ? "{}" : payloadJson);
          invokeCallable(requestId, "createOrder", firebaseIdToken, payload, null);
        } catch (Exception error) {
          publishNativeFailure(requestId, "createOrder", "INVALID_ARGUMENT",
              "The order request is invalid. Refresh the cart and try again.");
        }
      });
    }

    @JavascriptInterface public void getCheckoutConfiguration(String requestId, String firebaseIdToken,
                                                              String payloadJson) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        try {
          JSONObject payload = new JSONObject(payloadJson == null ? "{}" : payloadJson);
          invokeCallable(requestId, "getCheckoutConfiguration", firebaseIdToken, payload, null);
        } catch (Exception error) {
          publishNativeFailure(requestId, "getCheckoutConfiguration", "INVALID_ARGUMENT",
              "Checkout settings could not be loaded right now.");
        }
      });
    }

    @JavascriptInterface public void createPaymentIntent(String requestId, String firebaseIdToken,
                                                         String payloadJson) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        try {
          JSONObject payload = new JSONObject(payloadJson == null ? "{}" : payloadJson);
          invokeCallable(requestId, "createPaymentIntent", firebaseIdToken, payload, null);
        } catch (Exception error) {
          publishNativeFailure(requestId, "createPaymentIntent", "INVALID_ARGUMENT",
              "The payment request is invalid. Refresh and try again.");
        }
      });
    }

    @JavascriptInterface public void createPhonePeIntent(String requestId, String firebaseIdToken,
                                                         String payloadJson) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        try {
          JSONObject payload = new JSONObject(payloadJson == null ? "{}" : payloadJson);
          invokeCallable(requestId, "createPhonePeIntent", firebaseIdToken, payload, null);
        } catch (Exception error) {
          publishNativeFailure(requestId, "createPhonePeIntent", "INVALID_ARGUMENT",
              "The payment request is invalid. Refresh and try again.");
        }
      });
    }

    @JavascriptInterface public void openExternalPayment(String requestId, String paymentUrl) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        launchExternalPayment(requestId, paymentUrl);
      });
    }

    @JavascriptInterface public void getDeliveryOtp(String requestId, String orderId) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        JSONObject result = new JSONObject();
        try {
          result.put("orderId", orderId);
          result.put("deliveryOtp", secureOrderStore.getDeliveryOtp(orderId));
          publishNativeSuccess(requestId, "getDeliveryOtp", result);
        } catch (Exception error) {
          FirebaseCrashlytics.getInstance().recordException(error);
          publishNativeFailure(requestId, "getDeliveryOtp", "SECURE_STORAGE_UNAVAILABLE",
              "Delivery verification is temporarily unavailable on this device.");
        }
      });
    }

    @JavascriptInterface public void recoverDeliveryOtp(String requestId, String firebaseIdToken,
                                                         String orderId) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded() || !validRequestId(requestId)) return;
        JSONObject payload = new JSONObject();
        try {
          payload.put("orderId", orderId);
          invokeCallable(requestId, "recoverDeliveryOtp", firebaseIdToken, payload, null);
        } catch (Exception error) {
          publishNativeFailure(requestId, "recoverDeliveryOtp", "INVALID_ARGUMENT",
              "The delivery verification request is invalid.");
        }
      });
    }

    @JavascriptInterface public void deleteDeliveryOtp(String orderId) {
      runOnUiThread(() -> {
        if (isTrustedPageLoaded()) secureOrderStore.removeDeliveryOtp(orderId);
      });
    }

    @JavascriptInterface public void clearDeliveryOtps() {
      runOnUiThread(() -> {
        if (isTrustedPageLoaded()) secureOrderStore.clear();
      });
    }
  }

  private void invokeCallable(String requestId, String operation, String firebaseIdToken,
                              JSONObject payload, Runnable afterSuccess) {
    callableClient.call(operation, firebaseIdToken, payload, new FirebaseCallableClient.Callback() {
      @Override public void onSuccess(JSONObject result) {
        if ("createCodOrder".equals(operation) || "createOrder".equals(operation)
            || "recoverDeliveryOtp".equals(operation)) {
          String orderId = result.optString("orderId", "");
          String deliveryOtp = result.optString("deliveryOtp", "");
          try {
            secureOrderStore.putDeliveryOtp(orderId, deliveryOtp);
          } catch (Exception error) {
            FirebaseCrashlytics.getInstance().recordException(error);
            publishNativeFailure(requestId, operation, "SECURE_STORAGE_UNAVAILABLE",
                "The order was reserved, but its delivery code could not be protected. Retry safely to recover it.");
            return;
          }
        }
        if (afterSuccess != null) afterSuccess.run();
        publishNativeSuccess(requestId, operation, result);
      }

      @Override public void onFailure(String code, String message) {
        publishNativeFailure(requestId, operation, code, message);
      }
    });
  }

  private void launchExternalPayment(String requestId, String paymentUrl) {
    String raw = paymentUrl == null ? "" : paymentUrl.trim();
    if (raw.length() == 0 || raw.length() > 8_192) {
      publishNativeFailure(requestId, "openExternalPayment", "INVALID_ARGUMENT",
          "The payment link is invalid.");
      return;
    }
    try {
      Intent intent;
      if (raw.regionMatches(true, 0, "intent:", 0, "intent:".length())) {
        intent = Intent.parseUri(raw, Intent.URI_INTENT_SCHEME);
      } else {
        Uri uri = Uri.parse(raw);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        if (!"https".equals(scheme) && !"http".equals(scheme) && !"upi".equals(scheme)) {
          publishNativeFailure(requestId, "openExternalPayment", "INVALID_ARGUMENT",
              "This payment app link is not supported on this device.");
          return;
        }
        intent = new Intent(Intent.ACTION_VIEW, uri);
      }
      intent.addCategory(Intent.CATEGORY_BROWSABLE);
      Intent chooser = Intent.createChooser(intent, "Complete payment");
      if (chooser.resolveActivity(getPackageManager()) == null) {
        publishNativeFailure(requestId, "openExternalPayment", "APP_UNAVAILABLE",
            "No supported payment app is installed on this device.");
        return;
      }
      startActivity(chooser);
      JSONObject result = new JSONObject();
      try { result.put("opened", true); } catch (Exception ignored) { }
      publishNativeSuccess(requestId, "openExternalPayment", result);
    } catch (Exception error) {
      FirebaseCrashlytics.getInstance().recordException(error);
      publishNativeFailure(requestId, "openExternalPayment", "APP_UNAVAILABLE",
          "Could not open a supported payment app on this device.");
    }
  }

  private void publishNativeSuccess(String requestId, String operation, JSONObject data) {
    JSONObject response = new JSONObject();
    try {
      response.put("requestId", requestId);
      response.put("operation", operation);
      response.put("ok", true);
      response.put("data", data == null ? new JSONObject() : data);
    } catch (Exception ignored) { }
    publishJsonCallback("savrivoNativeResult", response);
  }

  private void publishNativeFailure(String requestId, String operation, String code, String message) {
    JSONObject response = new JSONObject();
    try {
      response.put("requestId", requestId);
      response.put("operation", operation);
      response.put("ok", false);
      response.put("code", code == null ? "FUNCTION_FAILED" : code);
      response.put("message", message == null ? "The request could not be completed." : message);
    } catch (Exception ignored) { }
    publishJsonCallback("savrivoNativeResult", response);
  }

  private void publishJsonCallback(String callback, JSONObject value) {
    if (webView == null || value == null) return;
    String encoded = Base64.encodeToString(
        value.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    String script = "window." + callback + " && window." + callback
        + "(JSON.parse(atob('" + encoded + "')));";
    webView.post(() -> {
      if (isTrustedPageLoaded()) webView.evaluateJavascript(script, null);
    });
  }

  private boolean validRequestId(String requestId) {
    return requestId != null && requestId.matches("[A-Za-z0-9_-]{1,80}");
  }

  private void requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
    }
  }

  @SuppressWarnings("deprecation")
  private String appVersion() {
    try {
      String version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
      return version == null ? "" : version.substring(0, Math.min(40, version.length()));
    } catch (Exception ignored) {
      return "";
    }
  }

  private String deviceModel() {
    String model = (Build.MANUFACTURER + " " + Build.MODEL).trim();
    return model.substring(0, Math.min(120, model.length()));
  }

  private void createOrderNotificationChannel() {
    CustomerMessagingService.createNotificationChannels(this);
  }

  private void showOrderNotification(String title, String body, int id) {
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
      return;
    }
    Intent launch = new Intent(this, MainActivity.class);
    launch.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent pending = PendingIntent.getActivity(this, id, launch,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, ORDER_CHANNEL) : new Notification.Builder(this);
    builder.setSmallIcon(R.drawable.savrivo_notification)
        .setContentTitle(title == null ? "Scraveit order update" : title)
        .setContentText(body == null ? "Your order has an update." : body)
        .setStyle(new Notification.BigTextStyle().bigText(body))
        .setAutoCancel(true).setContentIntent(pending);
    NotificationManager manager = (NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(id, builder.build());
  }

  private void fetchCurrentLocation() {
    stopLocationUpdates();
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
        && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{
          Manifest.permission.ACCESS_FINE_LOCATION,
          Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
      return;
    }
    activeLocationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    boolean locationServicesEnabled = false;
    try {
      locationServicesEnabled = activeLocationManager != null && (
          activeLocationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)
              || activeLocationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER));
    } catch (SecurityException ignored) { }
    if (!locationServicesEnabled) {
      promptEnableLocationServices();
      publishLocationServicesDisabled();
      return;
    }
    readBestAvailableLocation();
  }

  private void promptEnableLocationServices() {
    new AlertDialog.Builder(this)
        .setTitle("Turn on Location")
        .setMessage("Turn on Location Services to use your current delivery location.")
        .setNegativeButton("Not now", null)
        .setPositiveButton("Open settings", (dialog, which) -> {
          try {
            retryLocationOnResume = true;
            startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
          } catch (Exception ignored) { }
        })
        .show();
  }

  private void queuePushEvent(JSONObject event) {
    if (event == null) return;
    pendingPushEvent = event;
    CustomerMessagingService.consumePendingEvent(this);
    deliverPendingPushEvent();
  }

  private void deliverPendingPushEvent() {
    if (pendingPushEvent == null || !isTrustedPageLoaded()) return;
    JSONObject event = pendingPushEvent;
    pendingPushEvent = null;
    publishJsonCallback("savrivoPushReceived", event);
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    queuePushEvent(CustomerMessagingService.eventFromIntent(intent));
  }

  @SuppressLint("UnspecifiedRegisterReceiverFlag")
  @Override protected void onStart() {
    super.onStart();
    if (pushReceiverRegistered) return;
    IntentFilter filter = new IntentFilter(CustomerMessagingService.PUSH_ACTION);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(pushReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
    } else {
      registerReceiver(pushReceiver, filter);
    }
    pushReceiverRegistered = true;
  }

  @Override protected void onStop() {
    if (pushReceiverRegistered) {
      try { unregisterReceiver(pushReceiver); } catch (Exception ignored) { }
      pushReceiverRegistered = false;
    }
    super.onStop();
  }

  @Override protected void onResume() {
    super.onResume();
    deliverPendingPushEvent();
    if (retryLocationOnResume) {
      retryLocationOnResume = false;
      handler.postDelayed(new Runnable() {
        @Override public void run() {
          if (isTrustedPageLoaded()) fetchCurrentLocation();
        }
      }, 450);
    }
  }

  private void chooseGoogleAccount() {
    if (googleSignInInFlight) return;
    String serverClientId;
    try {
      serverClientId = getString(R.string.default_web_client_id);
    } catch (Exception ignored) {
      publishGoogleSignInFailure("Google sign-in is not configured for this build.");
      return;
    }
    if (serverClientId == null || serverClientId.trim().length() == 0) {
      publishGoogleSignInFailure("Google sign-in is not configured for this build.");
      return;
    }
    googleSignInInFlight = true;
    clearGoogleChooserStateThenRequest(serverClientId);
  }

  private void clearGoogleChooserStateThenRequest(String serverClientId) {
    credentialManager.clearCredentialStateAsync(
        new ClearCredentialStateRequest(),
        new CancellationSignal(),
        credentialExecutor,
        new CredentialManagerCallback<Void, ClearCredentialException>() {
          @Override public void onResult(Void ignored) {
            requestGoogleCredential(serverClientId);
          }

          @Override public void onError(ClearCredentialException error) {
            requestGoogleCredential(serverClientId);
          }
        });
  }

  private void requestGoogleCredential(String serverClientId) {
    GetSignInWithGoogleOption googleIdOption = new GetSignInWithGoogleOption.Builder(serverClientId)
        .build();
    GetCredentialRequest request = new GetCredentialRequest.Builder()
        .addCredentialOption(googleIdOption)
        .build();
    googleSignInCancellation = new CancellationSignal();
    credentialManager.getCredentialAsync(
        this,
        request,
        googleSignInCancellation,
        credentialExecutor,
        new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
          @Override public void onResult(GetCredentialResponse result) {
            handleGoogleCredential(result);
          }

          @Override public void onError(GetCredentialException error) {
            finishGoogleSignInWithError(error instanceof GetCredentialCancellationException
                ? "Google sign-in was cancelled."
                : "Google sign-in could not be completed. Check Google Play services and try again.");
          }
        });
  }

  private void handleGoogleCredential(GetCredentialResponse response) {
    Credential credential = response == null ? null : response.getCredential();
    if (!(credential instanceof CustomCredential)
        || (!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())
            && !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_SIWG_CREDENTIAL.equals(credential.getType()))) {
      finishGoogleSignInWithError("Google did not return a supported sign-in credential.");
      return;
    }
    try {
      GoogleIdTokenCredential googleCredential =
          GoogleIdTokenCredential.createFrom(credential.getData());
      String idToken = googleCredential.getIdToken();
      if (idToken == null || idToken.length() == 0) {
        finishGoogleSignInWithError("Google did not return a sign-in token. Please try again.");
        return;
      }
      runOnUiThread(() -> {
        googleSignInInFlight = false;
        googleSignInCancellation = null;
        publishGoogleIdToken(idToken);
      });
    } catch (RuntimeException error) {
      finishGoogleSignInWithError("Google returned an invalid sign-in response. Please try again.");
    }
  }

  private void finishGoogleSignInWithError(String message) {
    runOnUiThread(() -> {
      googleSignInInFlight = false;
      googleSignInCancellation = null;
      publishGoogleSignInFailure(message);
    });
  }

  @SuppressLint("MissingPermission")
  private void readBestAvailableLocation() {
    activeLocationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    if (activeLocationManager == null) {
      publishLocationUnavailable();
      return;
    }
    Location best = null;
    try {
      List<String> providers = activeLocationManager.getProviders(true);
      for (String provider : providers) {
        Location candidate = activeLocationManager.getLastKnownLocation(provider);
        if (candidate != null && (best == null || candidate.getTime() > best.getTime())) best = candidate;
      }
    } catch (SecurityException ignored) { }
    if (best != null) {
      resolveLocationName(best);
      return;
    }
    boolean requested = false;
    activeLocationListener = new LocationListener() {
        @Override public void onLocationChanged(Location location) {
          stopLocationUpdates();
          resolveLocationName(location);
        }
        @Override public void onProviderDisabled(String name) { }
        @Override public void onProviderEnabled(String name) { }
        @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
      };
    try {
      if (activeLocationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
        activeLocationManager.requestLocationUpdates(
            LocationManager.NETWORK_PROVIDER, 0, 0, activeLocationListener, Looper.getMainLooper());
        requested = true;
      }
      if (activeLocationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
        activeLocationManager.requestLocationUpdates(
            LocationManager.GPS_PROVIDER, 0, 0, activeLocationListener, Looper.getMainLooper());
        requested = true;
      }
    } catch (SecurityException ignored) {
      requested = false;
    }
    if (requested) handler.postDelayed(locationTimeout, 10000); else publishLocationUnavailable();
  }

  private void stopLocationUpdates() {
    handler.removeCallbacks(locationTimeout);
    if (activeLocationManager != null && activeLocationListener != null) {
      try { activeLocationManager.removeUpdates(activeLocationListener); } catch (SecurityException ignored) { }
    }
    activeLocationListener = null;
  }

  private void resolveLocationName(final Location location) {
    new Thread(new Runnable() {
      @Override public void run() {
        String label = "Current location";
        String area = "Nearby";
        String city = "";
        String details = String.format(Locale.US, "%.5f, %.5f", location.getLatitude(), location.getLongitude());
        if (Geocoder.isPresent()) {
          try {
            List<Address> matches = new Geocoder(MainActivity.this, Locale.getDefault())
                .getFromLocation(location.getLatitude(), location.getLongitude(), 1);
            if (matches != null && !matches.isEmpty()) {
              Address address = matches.get(0);
              if (notEmpty(address.getFeatureName())) label = address.getFeatureName();
              else if (notEmpty(address.getSubLocality())) label = address.getSubLocality();
              if (notEmpty(address.getSubLocality())) area = address.getSubLocality();
              else if (notEmpty(address.getLocality())) area = address.getLocality();
              if (notEmpty(address.getLocality())) city = address.getLocality();
              else if (notEmpty(address.getSubAdminArea())) city = address.getSubAdminArea();
              if (notEmpty(address.getAddressLine(0))) details = address.getAddressLine(0);
            }
          } catch (IOException ignored) { }
        }
        publishDetectedLocation(label, area, city, details, location.getLatitude(), location.getLongitude());
      }
    }).start();
  }

  private boolean notEmpty(String value) {
    return value != null && value.trim().length() > 0;
  }

  private void publishDetectedLocation(String label, String area, String city, String details,
                                       double latitude, double longitude) {
    if (webView == null) return;
    final String script = "window.setDetectedLocation && window.setDetectedLocation('"
        + escapeJavascript(label) + "','" + escapeJavascript(area) + "','"
        + escapeJavascript(city) + "','" + escapeJavascript(details) + "'," + latitude + "," + longitude + ");";
    webView.post(new Runnable() {
      @Override public void run() {
        if (isTrustedPageLoaded()) webView.evaluateJavascript(script, null);
      }
    });
  }

  private void publishLocationUnavailable() {
    if (webView == null) return;
    webView.post(new Runnable() {
      @Override public void run() {
        if (isTrustedPageLoaded()) {
          webView.evaluateJavascript("window.locationUnavailable && window.locationUnavailable()", null);
        }
      }
    });
  }

  private void publishLocationServicesDisabled() {
    if (webView == null) return;
    webView.post(new Runnable() {
      @Override public void run() {
        if (isTrustedPageLoaded()) {
          webView.evaluateJavascript(
              "window.locationServicesDisabled && window.locationServicesDisabled()", null);
        }
      }
    });
  }

  private void publishGoogleIdToken(String token) {
    if (webView == null) return;
    final String script = "window.googleIdTokenReceived && window.googleIdTokenReceived('"
        + escapeJavascript(token) + "');";
    webView.post(new Runnable() {
      @Override public void run() {
        if (isTrustedPageLoaded()) webView.evaluateJavascript(script, null);
      }
    });
  }

  private void publishGoogleSignInFailure(String message) {
    if (webView == null) return;
    final String script = "window.googleSignInFailed && window.googleSignInFailed('"
        + escapeJavascript(message) + "');";
    webView.post(new Runnable() {
      @Override public void run() {
        if (isTrustedPageLoaded()) webView.evaluateJavascript(script, null);
      }
    });
  }

  private String escapeJavascript(String value) {
    if (value == null) return "";
    return value.replace("\\", "\\\\").replace("'", "\\'")
        .replace("\n", "\\n").replace("\r", "");
  }

  @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode == LOCATION_REQUEST) {
      if (!isTrustedPageLoaded()) return;
      boolean granted = false;
      for (int result : grantResults) if (result == PackageManager.PERMISSION_GRANTED) granted = true;
      if (granted) fetchCurrentLocation(); else publishLocationUnavailable();
    }
  }

  @Override protected void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    stopLocationUpdates();
    if (callableClient != null) callableClient.close();
    if (googleSignInCancellation != null) googleSignInCancellation.cancel();
    googleSignInCancellation = null;
    credentialExecutor.shutdownNow();
    if (webView != null) {
      webView.removeJavascriptInterface("FeastlyNative");
      webView.stopLoading();
      webView.loadUrl("about:blank");
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }
}
