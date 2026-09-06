package com.feastly.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Notification;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.Manifest;
import android.annotation.SuppressLint;
import android.accounts.Account;
import android.accounts.AccountManager;
import android.accounts.AccountManagerFuture;
import android.content.Context;
import android.content.Intent;
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
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
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

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;

public class MainActivity extends Activity {
  private static final int LOCATION_REQUEST = 4401;
  private static final int GOOGLE_ACCOUNT_REQUEST = 4402;
  private static final int NOTIFICATION_REQUEST = 4403;
  private static final String ORDER_CHANNEL = "savrivo_customer_orders";
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
  private final Runnable locationTimeout = new Runnable() {
    @Override public void run() {
      stopLocationUpdates();
      publishLocationUnavailable();
    }
  };

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    openedAt = System.currentTimeMillis();

    final FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.rgb(246, 249, 253));

    final WebView view = new WebView(this);
    webView = view;
    view.setVisibility(View.INVISIBLE);
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setGeolocationEnabled(true);
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
    view.setWebChromeClient(new WebChromeClient());
    view.addJavascriptInterface(new LocationBridge(), "FeastlyNative");
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
          }
        }, remaining);
      }
    });
    view.loadUrl(TRUSTED_PAGE);
    root.addView(view, new FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

    splash.setClickable(false);
    ImageView logo = new ImageView(this);
    logo.setImageResource(com.feastly.app.R.drawable.savrivo_icon);
    logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
    logo.setAlpha(0f);
    logo.setScaleX(0.72f);
    logo.setScaleY(0.72f);
    FrameLayout.LayoutParams logoParams = new FrameLayout.LayoutParams(dp(154), dp(154), Gravity.CENTER);
    logoParams.bottomMargin = dp(56);
    splash.addView(logo, logoParams);

    TextView brand = new TextView(this);
    brand.setText("SAVRIVO");
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
    tagline.setText("FOOD, THOUGHTFULLY DELIVERED");
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

  @Override public void onBackPressed() {
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

  private class LocationBridge {
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
  }

  private void createOrderNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationChannel channel = new NotificationChannel(
        ORDER_CHANNEL, "Order updates", NotificationManager.IMPORTANCE_HIGH);
    channel.setDescription("Confirmation and delivery arrival updates");
    NotificationManager manager = (NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.createNotificationChannel(channel);
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
        .setContentTitle(title == null ? "Savrivo order update" : title)
        .setContentText(body == null ? "Your order has an update." : body)
        .setStyle(new Notification.BigTextStyle().bigText(body))
        .setAutoCancel(true).setContentIntent(pending);
    NotificationManager manager = (NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(id, builder.build());
  }

  private void fetchCurrentLocation() {
    stopLocationUpdates();
    if (android.os.Build.VERSION.SDK_INT >= 23
        && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
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

  @Override protected void onResume() {
    super.onResume();
    if (!retryLocationOnResume) return;
    retryLocationOnResume = false;
    handler.postDelayed(new Runnable() {
      @Override public void run() {
        if (isTrustedPageLoaded()) fetchCurrentLocation();
      }
    }, 450);
  }

  private void chooseGoogleAccount() {
    try {
      Intent chooser = AccountManager.newChooseAccountIntent(
          null, null, new String[]{"com.google"}, false,
          null, null, null, null);
      startActivityForResult(chooser, GOOGLE_ACCOUNT_REQUEST);
    } catch (Exception error) {
      publishGoogleSignInFailure("Google account selection is not available on this device.");
    }
  }

  @SuppressLint("MissingPermission")
  private void requestGoogleAccessToken(String accountName) {
    if (accountName == null || accountName.trim().length() == 0) {
      publishGoogleSignInFailure("No Google account was selected.");
      return;
    }
    Account account = new Account(accountName, "com.google");
    AccountManager manager = AccountManager.get(this);
    manager.getAuthToken(account, "oauth2:openid profile email", null, this,
        future -> {
          try {
            Bundle result = future.getResult();
            String token = result.getString(AccountManager.KEY_AUTHTOKEN);
            if (token == null || token.length() == 0) {
              publishGoogleSignInFailure("Google did not return a sign-in token. Please try again.");
              return;
            }
            publishGoogleAccessToken(token);
          } catch (Exception error) {
            publishGoogleSignInFailure("Google sign-in could not be completed. Please try again.");
          }
        }, null);
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
              if (notEmpty(address.getAddressLine(0))) details = address.getAddressLine(0);
            }
          } catch (IOException ignored) { }
        }
        publishDetectedLocation(label, area, details, location.getLatitude(), location.getLongitude());
      }
    }).start();
  }

  private boolean notEmpty(String value) {
    return value != null && value.trim().length() > 0;
  }

  private void publishDetectedLocation(String label, String area, String details,
                                       double latitude, double longitude) {
    if (webView == null) return;
    final String script = "window.setDetectedLocation && window.setDetectedLocation('"
        + escapeJavascript(label) + "','" + escapeJavascript(area) + "','"
        + escapeJavascript(details) + "'," + latitude + "," + longitude + ");";
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

  private void publishGoogleAccessToken(String token) {
    if (webView == null) return;
    final String script = "window.googleAccessTokenReceived && window.googleAccessTokenReceived('"
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

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != GOOGLE_ACCOUNT_REQUEST) return;
    if (!isTrustedPageLoaded()) return;
    if (resultCode != RESULT_OK || data == null) {
      publishGoogleSignInFailure("Google sign-in was cancelled.");
      return;
    }
    requestGoogleAccessToken(data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME));
  }

  @Override protected void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    stopLocationUpdates();
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
