package com.feastly.admin;

import android.Manifest;
import android.app.Activity;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

public class MainActivity extends Activity {
  private static final int FILE_CHOOSER_REQUEST = 7301;
  private static final int LOCATION_REQUEST = 7302;
  private static final int NOTIFICATION_REQUEST = 7303;
  private static final String NOTIFICATION_CHANNEL = "savrivo_control_orders";
  private static final String TRUSTED_HOST = "appassets.androidplatform.net";
  private static final String TRUSTED_ORIGIN = "https://" + TRUSTED_HOST + "/assets/";
  private static final String TRUSTED_PAGE = TRUSTED_ORIGIN + "premium.html";
  private final Handler handler = new Handler(android.os.Looper.getMainLooper());
  private long openedAt;
  private long lastBackPressed;
  private WebView webView;
  private ValueCallback<Uri[]> fileChooserCallback;
  private boolean awaitingRestaurantLocation;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE,
        WindowManager.LayoutParams.FLAG_SECURE);
    openedAt = System.currentTimeMillis();
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.rgb(6, 20, 40));

    WebView view = new WebView(this);
    webView = view;
    view.setVisibility(View.INVISIBLE);
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setSupportMultipleWindows(false);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setSaveFormData(false);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      settings.setSafeBrowsingEnabled(true);
    }
    settings.setDefaultTextEncodingName("UTF-8");
    WebView.setWebContentsDebuggingEnabled(false);
    view.removeJavascriptInterface("searchBoxJavaBridge_");
    view.removeJavascriptInterface("accessibility");
    view.removeJavascriptInterface("accessibilityTraversal");
    view.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                                 FileChooserParams params) {
        if (!isTrustedPageLoaded()) {
          callback.onReceiveValue(null);
          return false;
        }
        if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
        fileChooserCallback = callback;
        Intent chooser = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        chooser.addCategory(Intent.CATEGORY_OPENABLE);
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        chooser.setType("image/*");
        try { startActivityForResult(chooser, FILE_CHOOSER_REQUEST); }
        catch (Exception error) {
          fileChooserCallback.onReceiveValue(null);
          fileChooserCallback = null;
          return false;
        }
        return true;
      }
    });
    view.addJavascriptInterface(new AdminBridge(), "FeastlyAdminNative");

    FrameLayout splash = new FrameLayout(this);
    ImageView logo = new ImageView(this);
    logo.setImageResource(com.feastly.admin.R.drawable.savrivo_icon);
    logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
    logo.setAlpha(0f);
    logo.setScaleX(.72f);
    logo.setScaleY(.72f);
    FrameLayout.LayoutParams logoParams = new FrameLayout.LayoutParams(dp(124), dp(124), Gravity.CENTER);
    logoParams.bottomMargin = dp(54);
    splash.addView(logo, logoParams);

    TextView title = new TextView(this);
    title.setText("SAVRIVO  CONTROL");
    title.setTextColor(Color.rgb(161, 220, 255));
    title.setTextSize(17);
    title.setGravity(Gravity.CENTER);
    title.setLetterSpacing(.13f);
    title.setAlpha(0f);
    FrameLayout.LayoutParams titleParams = new FrameLayout.LayoutParams(dp(300), dp(34), Gravity.CENTER);
    titleParams.topMargin = dp(144);
    splash.addView(title, titleParams);

    TextView tag = new TextView(this);
    tag.setText("EVERY ORDER, IN CONTROL");
    tag.setTextColor(Color.rgb(104, 159, 205));
    tag.setTextSize(9);
    tag.setGravity(Gravity.CENTER);
    tag.setLetterSpacing(.10f);
    tag.setAlpha(0f);
    FrameLayout.LayoutParams tagParams = new FrameLayout.LayoutParams(dp(300), dp(24), Gravity.CENTER);
    tagParams.topMargin = dp(180);
    splash.addView(tag, tagParams);

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
      @Override public void onPageFinished(WebView ignored, String url) {
        if (!isTrustedPage(url)) return;
        long wait = Math.max(0, 720 - (System.currentTimeMillis() - openedAt));
        handler.postDelayed(() -> {
          if (!isTrustedPageLoaded()) return;
          view.setVisibility(View.VISIBLE);
          splash.setVisibility(View.GONE);
        }, wait);
      }
    });
    view.loadUrl(TRUSTED_PAGE);
    root.addView(view, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    root.addView(splash, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    setContentView(root);

    AnimatorSet intro = new AnimatorSet();
    intro.setInterpolator(new DecelerateInterpolator());
    intro.playTogether(
        ObjectAnimator.ofFloat(logo, View.ALPHA, 0f, 1f),
        ObjectAnimator.ofFloat(logo, View.SCALE_X, .72f, 1f),
        ObjectAnimator.ofFloat(logo, View.SCALE_Y, .72f, 1f),
        ObjectAnimator.ofFloat(title, View.ALPHA, 0f, 1f),
        ObjectAnimator.ofFloat(tag, View.ALPHA, 0f, 1f));
    intro.setStartDelay(65);
    intro.setDuration(470);
    intro.start();
  }

  private int dp(int value) { return (int)(value * getResources().getDisplayMetrics().density + .5f); }

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

  @Override public void onBackPressed() {
    if (!isTrustedPageLoaded()) { confirmExit(); return; }
    webView.evaluateJavascript("window.handleAdminBack ? window.handleAdminBack() : 'root'", result -> {
      if (result != null && result.contains("handled")) return;
      confirmExit();
    });
  }

  private void confirmExit() {
    long now = System.currentTimeMillis();
    if (now - lastBackPressed < 2000) finish();
    else { lastBackPressed = now; Toast.makeText(this, "Press back again to exit", Toast.LENGTH_SHORT).show(); }
  }

  private class AdminBridge {
    @JavascriptInterface public void vibrateSuccess() {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded()) return;
        // Reserved for a subtle native success haptic without exposing an untrusted action.
      });
    }
    @JavascriptInterface public void requestRestaurantLocation() {
      runOnUiThread(() -> {
        if (isTrustedPageLoaded()) requestRestaurantLocationInternal();
      });
    }
    @JavascriptInterface public void openNavigation(String destination) {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded()) return;
        String target = destination == null ? "" : destination.trim();
        if (target.length() == 0) return;
        Uri url = Uri.parse("https://www.google.com/maps/dir/?api=1&destination=" + Uri.encode(target));
        try { startActivity(new Intent(Intent.ACTION_VIEW, url)); }
        catch (Exception ignored) { }
      });
    }
    @JavascriptInterface public void notifyOrder(String title, String body, int id) {
      runOnUiThread(() -> {
        if (isTrustedPageLoaded()) showOrderNotification(title, body, id);
      });
    }
  }

  private void requestRestaurantLocationInternal() {
    awaitingRestaurantLocation = true;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
        && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
        && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
          Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
      return;
    }
    captureRestaurantLocation();
  }

  @SuppressWarnings("MissingPermission")
  private void captureRestaurantLocation() {
    LocationManager manager = (LocationManager)getSystemService(Context.LOCATION_SERVICE);
    if (manager == null) { publishRestaurantLocation(null); return; }
    Location best = null;
    try {
      for (String provider : manager.getProviders(true)) {
        Location candidate = manager.getLastKnownLocation(provider);
        if (candidate != null && (best == null || candidate.getTime() > best.getTime())) best = candidate;
      }
    } catch (Exception ignored) { }
    if (best != null) { publishRestaurantLocation(best); return; }
    try {
      String provider = manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
          ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
      manager.requestSingleUpdate(provider, new LocationListener() {
        @Override public void onLocationChanged(Location location) { publishRestaurantLocation(location); }
        @Override public void onProviderDisabled(String provider) { publishRestaurantLocation(null); }
        @Override public void onProviderEnabled(String provider) { }
        @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
      }, null);
    } catch (Exception error) { publishRestaurantLocation(null); }
  }

  private void publishRestaurantLocation(Location location) {
    awaitingRestaurantLocation = false;
    if (webView == null) return;
    String script = location == null
        ? "window.adminLocationUnavailable&&window.adminLocationUnavailable()"
        : "window.adminLocationReceived&&window.adminLocationReceived(" + location.getLatitude()
          + "," + location.getLongitude() + ")";
    webView.post(() -> {
      if (isTrustedPageLoaded()) webView.evaluateJavascript(script, null);
    });
  }

  private void showOrderNotification(String title, String body, int id) {
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
      return;
    }
    NotificationManager manager = (NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager == null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(NOTIFICATION_CHANNEL,
          "Order operations", NotificationManager.IMPORTANCE_HIGH);
      manager.createNotificationChannel(channel);
    }
    Intent open = new Intent(this, MainActivity.class);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent pending = PendingIntent.getActivity(this, id, open, flags);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, NOTIFICATION_CHANNEL) : new Notification.Builder(this);
    manager.notify(id, builder.setSmallIcon(com.feastly.admin.R.drawable.savrivo_notification)
        .setContentTitle(title == null ? "Savrivo Control" : title)
        .setContentText(body == null ? "Order update" : body)
        .setAutoCancel(true).setContentIntent(pending).build());
  }

  @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(requestCode, permissions, results);
    if (requestCode == LOCATION_REQUEST && awaitingRestaurantLocation) {
      if (!isTrustedPageLoaded()) {
        awaitingRestaurantLocation = false;
        return;
      }
      boolean granted = false;
      for (int result : results) if (result == PackageManager.PERMISSION_GRANTED) granted = true;
      if (granted) captureRestaurantLocation(); else publishRestaurantLocation(null);
    }
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) return;
    if (isTrustedPageLoaded()) {
      fileChooserCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
    } else {
      fileChooserCallback.onReceiveValue(null);
    }
    fileChooserCallback = null;
  }

  @Override protected void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    if (fileChooserCallback != null) {
      fileChooserCallback.onReceiveValue(null);
      fileChooserCallback = null;
    }
    if (webView != null) {
      webView.removeJavascriptInterface("FeastlyAdminNative");
      webView.stopLoading();
      webView.loadUrl("about:blank");
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }
}
