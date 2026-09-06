package com.feastly.rider;

import android.Manifest;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int LOCATION_PERMISSION_REQUEST = 6201;
    private static final int FILE_CHOOSER_REQUEST = 6202;
    private static final String TRUSTED_ORIGIN = "https://appassets.androidplatform.net/assets/";
    private static final String TRUSTED_PAGE = TRUSTED_ORIGIN + "premium.html";
    private static final int CANVAS = Color.rgb(7, 20, 38);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    private long openedAt;
    private long lastBackPressed;
    private boolean pagePresented;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        openedAt = System.currentTimeMillis();
        configureSystemBars();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(CANVAS);

        WebView view = new WebView(this);
        webView = view;
        view.setBackgroundColor(CANVAS);
        view.setVisibility(View.INVISIBLE);
        WebView.setWebContentsDebuggingEnabled(false);

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
        settings.setDefaultTextEncodingName("UTF-8");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);

        view.removeJavascriptInterface("searchBoxJavaBridge_");
        view.removeJavascriptInterface("accessibility");
        view.removeJavascriptInterface("accessibilityTraversal");
        view.addJavascriptInterface(new RiderBridge(), "FeastlyRiderNative");

        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView source, ValueCallback<Uri[]> callback,
                                                       FileChooserParams params) {
                if (!isTrustedPageLoaded()) return false;
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                Intent chooser = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                chooser.addCategory(Intent.CATEGORY_OPENABLE);
                chooser.setType("image/*");
                try {
                    startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception error) {
                    fileChooserCallback.onReceiveValue(null);
                    fileChooserCallback = null;
                    return false;
                }
            }
        });

        FrameLayout splash = buildSplash();
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView source, String url) {
                return handleNavigation(url == null ? null : Uri.parse(url));
            }

            @Override public boolean shouldOverrideUrlLoading(WebView source, WebResourceRequest request) {
                return handleNavigation(request == null ? null : request.getUrl());
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView source,
                                                                        WebResourceRequest request) {
                Uri uri = request == null ? null : request.getUrl();
                WebResourceResponse local = servePackagedAsset(uri);
                return local == null ? super.shouldInterceptRequest(source, request) : local;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView source, String url) {
                Uri uri = url == null ? null : Uri.parse(url);
                WebResourceResponse local = servePackagedAsset(uri);
                return local == null ? super.shouldInterceptRequest(source, url) : local;
            }

            @Override public void onPageFinished(WebView source, String url) {
                if (url != null && url.startsWith(TRUSTED_PAGE)) presentPage(view, splash);
            }
        });

        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(splash, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        animateSplash(splash);
        view.loadUrl(TRUSTED_PAGE);
    }

    private void configureSystemBars() {
        getWindow().setStatusBarColor(CANVAS);
        getWindow().setNavigationBarColor(CANVAS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }
    }

    private FrameLayout buildSplash() {
        FrameLayout splash = new FrameLayout(this);
        splash.setBackgroundColor(CANVAS);
        splash.setClickable(false);

        ImageView logo = new ImageView(this);
        logo.setImageResource(com.feastly.rider.R.drawable.savrivo_partner_icon);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        logo.setAlpha(0f);
        logo.setScaleX(.76f);
        logo.setScaleY(.76f);
        FrameLayout.LayoutParams logoParams = new FrameLayout.LayoutParams(dp(126), dp(126), Gravity.CENTER);
        logoParams.bottomMargin = dp(58);
        splash.addView(logo, logoParams);

        TextView brand = new TextView(this);
        brand.setText("SAVRIVO  PARTNER");
        brand.setTextColor(Color.rgb(185, 224, 255));
        brand.setTextSize(17);
        brand.setGravity(Gravity.CENTER);
        brand.setLetterSpacing(.13f);
        brand.setAlpha(0f);
        brand.setTranslationY(dp(10));
        FrameLayout.LayoutParams brandParams = new FrameLayout.LayoutParams(dp(320), dp(36), Gravity.CENTER);
        brandParams.topMargin = dp(142);
        splash.addView(brand, brandParams);

        TextView tagline = new TextView(this);
        tagline.setText("CLEAR JOBS. SAFER JOURNEYS.");
        tagline.setTextColor(Color.rgb(120, 161, 202));
        tagline.setTextSize(9);
        tagline.setGravity(Gravity.CENTER);
        tagline.setLetterSpacing(.10f);
        tagline.setAlpha(0f);
        tagline.setTranslationY(dp(8));
        FrameLayout.LayoutParams tagParams = new FrameLayout.LayoutParams(dp(330), dp(26), Gravity.CENTER);
        tagParams.topMargin = dp(182);
        splash.addView(tagline, tagParams);
        return splash;
    }

    private void animateSplash(FrameLayout splash) {
        if (splash.getChildCount() < 3) return;
        View logo = splash.getChildAt(0);
        View brand = splash.getChildAt(1);
        View tagline = splash.getChildAt(2);
        AnimatorSet intro = new AnimatorSet();
        intro.setInterpolator(new DecelerateInterpolator());
        intro.playTogether(
                ObjectAnimator.ofFloat(logo, View.ALPHA, 0f, 1f),
                ObjectAnimator.ofFloat(logo, View.SCALE_X, .76f, 1f),
                ObjectAnimator.ofFloat(logo, View.SCALE_Y, .76f, 1f),
                ObjectAnimator.ofFloat(brand, View.ALPHA, 0f, 1f),
                ObjectAnimator.ofFloat(brand, View.TRANSLATION_Y, dp(10), 0f),
                ObjectAnimator.ofFloat(tagline, View.ALPHA, 0f, 1f),
                ObjectAnimator.ofFloat(tagline, View.TRANSLATION_Y, dp(8), 0f));
        intro.setStartDelay(55);
        intro.setDuration(440);
        intro.start();
    }

    private void presentPage(WebView view, View splash) {
        if (pagePresented) return;
        pagePresented = true;
        long wait = Math.max(0, 700 - (System.currentTimeMillis() - openedAt));
        handler.postDelayed(() -> {
            view.setVisibility(View.VISIBLE);
            splash.animate().alpha(0f).setDuration(150).withEndAction(() -> {
                splash.setVisibility(View.GONE);
                splash.setAlpha(1f);
            }).start();
        }, wait);
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + .5f);
    }

    private boolean isTrustedPageLoaded() {
        if (webView == null) return false;
        String url = webView.getUrl();
        return url != null && url.startsWith(TRUSTED_PAGE);
    }

    private boolean handleNavigation(Uri uri) {
        if (uri == null) return true;
        String raw = uri.toString();
        if (raw.startsWith(TRUSTED_ORIGIN)) return false;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        if ("https".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme)
                || "geo".equals(scheme)) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
            catch (Exception ignored) { }
        }
        return true;
    }

    private WebResourceResponse servePackagedAsset(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())
                || !"appassets.androidplatform.net".equalsIgnoreCase(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || !path.startsWith("/assets/")) return blockedAssetResponse();
        String asset = path.substring("/assets/".length());
        if (asset.length() == 0 || asset.contains("..") || asset.contains("\\")) {
            return blockedAssetResponse();
        }
        try {
            InputStream input = getAssets().open(asset);
            return new WebResourceResponse(assetMimeType(asset), assetEncoding(asset), input);
        } catch (Exception ignored) {
            return blockedAssetResponse();
        }
    }

    private WebResourceResponse blockedAssetResponse() {
        byte[] body = "Not found".getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(body));
    }

    private String assetMimeType(String asset) {
        String name = asset.toLowerCase(Locale.US);
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".js")) return "application/javascript";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".webp")) return "image/webp";
        return "application/octet-stream";
    }

    private String assetEncoding(String asset) {
        String name = asset.toLowerCase(Locale.US);
        return name.endsWith(".html") || name.endsWith(".css") || name.endsWith(".js")
                || name.endsWith(".json") || name.endsWith(".svg") ? "UTF-8" : null;
    }

    private class RiderBridge {
        @JavascriptInterface public void requestLocationAccess() {
            runOnUiThread(() -> {
                if (isTrustedPageLoaded()) requestLocationAccessInternal();
            });
        }

        @JavascriptInterface public void openLocationSettings() {
            runOnUiThread(() -> {
                if (!isTrustedPageLoaded()) return;
                try { startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); }
                catch (Exception ignored) { }
            });
        }

        @JavascriptInterface public void startDeliveryTracking(
                String customerId, String orderId, String riderId, String riderName, String token) {
            runOnUiThread(() -> startTracking(customerId, orderId, "", riderId, riderName, token, "", "",
                    Double.NaN, Double.NaN, "pickup"));
        }

        @JavascriptInterface public void startAdvancedTracking(
                String customerId, String orderId, String restaurantId, String riderId, String riderName, String token,
                String refreshToken, String firebaseApiKey, double customerLat, double customerLng, String phase) {
            runOnUiThread(() -> startTracking(customerId, orderId, restaurantId, riderId, riderName, token,
                    refreshToken, firebaseApiKey,
                    customerLat, customerLng, phase));
        }

        @JavascriptInterface public void openNavigation(String destination) {
            runOnUiThread(() -> {
                if (!isTrustedPageLoaded()) return;
                String target = destination == null ? "" : destination.trim();
                if (target.length() == 0 || target.length() > 500 || containsControlCharacter(target)) return;
                Uri googleNavigation = Uri.parse("google.navigation:q=" + Uri.encode(target));
                Intent maps = new Intent(Intent.ACTION_VIEW, googleNavigation);
                maps.setPackage("com.google.android.apps.maps");
                try { startActivity(maps); }
                catch (Exception unavailable) {
                    Uri web = Uri.parse("https://www.google.com/maps/dir/?api=1&destination="
                            + Uri.encode(target));
                    try { startActivity(new Intent(Intent.ACTION_VIEW, web)); }
                    catch (Exception ignored) { }
                }
            });
        }

        @JavascriptInterface public void stopDeliveryTracking() {
            runOnUiThread(() -> {
                if (!isTrustedPageLoaded()) return;
                Intent service = new Intent(MainActivity.this, TrackingService.class);
                service.setAction(TrackingService.ACTION_STOP);
                startService(service);
            });
        }
    }

    private void startTracking(String customerId, String orderId, String restaurantId, String riderId, String riderName,
                               String token, String refreshToken, String firebaseApiKey,
                               double customerLat, double customerLng, String phase) {
        if (!isTrustedPageLoaded() || !safeFirebaseKey(customerId) || !safeFirebaseKey(orderId)
                || !safeFirebaseKey(riderId) || !safeToken(token)) return;
        if (!hasLocationPermission() || !locationServicesEnabled()) {
            publishLocationResult(false, locationServicesEnabled());
            return;
        }
        String safeName = riderName == null ? "Savrivo Partner" : riderName.trim();
        if (safeName.length() == 0) safeName = "Savrivo Partner";
        if (safeName.length() > 80) safeName = safeName.substring(0, 80);
        String safePhase = "delivery".equals(phase) ? "delivery" : "pickup";
        boolean validCoordinates = isFinite(customerLat) && isFinite(customerLng)
                && Math.abs(customerLat) <= 90 && Math.abs(customerLng) <= 180
                && !(customerLat == 0d && customerLng == 0d);

        Intent service = new Intent(this, TrackingService.class);
        service.putExtra("customerId", customerId);
        service.putExtra("orderId", orderId);
        service.putExtra("restaurantId", safeFirebaseKey(restaurantId) ? restaurantId : "");
        service.putExtra("riderId", riderId);
        service.putExtra("riderName", safeName);
        service.putExtra("token", token);
        service.putExtra("refreshToken", safeRefreshToken(refreshToken) ? refreshToken : "");
        service.putExtra("firebaseApiKey", safeFirebaseApiKey(firebaseApiKey) ? firebaseApiKey : "");
        service.putExtra("customerLat", validCoordinates ? customerLat : Double.NaN);
        service.putExtra("customerLng", validCoordinates ? customerLng : Double.NaN);
        service.putExtra("phase", safePhase);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
        else startService(service);
    }

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

    private boolean isFinite(double value) {
        return !Double.isNaN(value) && !Double.isInfinite(value);
    }

    private boolean containsControlCharacter(String value) {
        for (int index = 0; index < value.length(); index++) {
            if (Character.isISOControl(value.charAt(index))) return true;
        }
        return false;
    }

    private void requestLocationAccessInternal() {
        if (hasLocationPermission()) {
            if (!locationServicesEnabled()) promptEnableLocation();
            publishLocationResult(true, locationServicesEnabled());
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION_REQUEST);
        } else publishLocationResult(true, locationServicesEnabled());
    }

    private boolean hasLocationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
    }

    private boolean locationServicesEnabled() {
        LocationManager manager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return false;
        try {
            return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception ignored) {
            return false;
        }
    }

    private void promptEnableLocation() {
        new AlertDialog.Builder(this)
                .setTitle("Turn on Location")
                .setMessage("Savrivo Partner shares location only during an active assigned delivery so the customer and operations team can follow progress.")
                .setNegativeButton("Not now", null)
                .setPositiveButton("Open settings", (dialog, which) -> {
                    try { startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); }
                    catch (Exception ignored) { }
                }).show();
    }

    private void publishLocationResult(boolean granted, boolean enabled) {
        if (!isTrustedPageLoaded()) return;
        final String script = "window.riderLocationPermissionResult && window.riderLocationPermissionResult("
                + granted + "," + enabled + ")";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    @Override public void onBackPressed() {
        if (webView == null || !isTrustedPageLoaded()) {
            confirmExit();
            return;
        }
        webView.evaluateJavascript(
                "window.FeastlyRiderBack ? window.FeastlyRiderBack() : 'root'", value -> {
                    if (value != null && value.contains("handled")) return;
                    confirmExit();
                });
    }

    private void confirmExit() {
        long now = System.currentTimeMillis();
        if (now - lastBackPressed < 2000) finish();
        else {
            lastBackPressed = now;
            Toast.makeText(this, "Press back again to exit Savrivo Partner", Toast.LENGTH_SHORT).show();
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                                     int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != LOCATION_PERMISSION_REQUEST) return;
        boolean granted = false;
        for (int result : grantResults) {
            if (result == PackageManager.PERMISSION_GRANTED) granted = true;
        }
        if (granted && !locationServicesEnabled()) promptEnableLocation();
        publishLocationResult(granted, locationServicesEnabled());
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) return;
        Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        fileChooserCallback.onReceiveValue(result);
        fileChooserCallback = null;
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null && hasLocationPermission()) {
            publishLocationResult(true, locationServicesEnabled());
        }
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("FeastlyRiderNative");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
