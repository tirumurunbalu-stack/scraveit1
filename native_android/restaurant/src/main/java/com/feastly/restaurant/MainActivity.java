package com.feastly.restaurant;

import android.Manifest;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.graphics.Paint;
import android.graphics.RectF;
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

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.FileProvider;

import com.savrivo.firebase.SavrivoOperationsBridge;
import com.savrivo.firebase.SavrivoWebPushBinder;
import com.savrivo.firebase.GoogleCredentialSignIn;

import java.io.ByteArrayInputStream;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONObject;

public class MainActivity extends ComponentActivity {
  private static final int FILE_CHOOSER_REQUEST = 7301;
  private static final int LOCATION_REQUEST = 7302;
  private static final String TRUSTED_HOST = "appassets.androidplatform.net";
  private static final String TRUSTED_ORIGIN = "https://" + TRUSTED_HOST + "/assets/";
  private static final String TRUSTED_PAGE = TRUSTED_ORIGIN + "premium.html";
  private static final int PREPARED_IMAGE_MAX_EDGE = 1800;
  private static final long MAX_SOURCE_IMAGE_BYTES = 50L * 1024L * 1024L;
  private final Handler handler = new Handler(android.os.Looper.getMainLooper());
  private final ExecutorService imageExecutor = Executors.newSingleThreadExecutor();
  private long openedAt;
  private long lastBackPressed;
  private WebView webView;
  private GoogleCredentialSignIn googleSignIn;
  /** Written from UI-thread WebView callbacks and read by the bridge worker thread. */
  private volatile boolean trustedPageLoaded;
  private SavrivoWebPushBinder pushBinder;
  private ValueCallback<Uri[]> fileChooserCallback;
  private volatile File preparedImageFile;
  private boolean awaitingRestaurantLocation;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    googleSignIn = new GoogleCredentialSignIn(this);
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override public void handleOnBackPressed() {
        handleBackRequest();
      }
    });
    // DEVELOPMENT ONLY: screenshots allowed while testing.
    // FINAL RELEASE: restore FLAG_SECURE before production APK/AAB.
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
    // The chooser returns an app-owned prepared JPEG through FileProvider.
    settings.setAllowContentAccess(true);
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
    view.addJavascriptInterface(new RestaurantBridge(), "FeastlyRestaurantNative");
    view.addJavascriptInterface(
        new SavrivoOperationsBridge(this, view, this::isTrustedPageLoaded),
        "SavrivoCloudNative");
    pushBinder = new SavrivoWebPushBinder(this, view, this::isTrustedPageLoaded);
    pushBinder.onNewIntent(getIntent());

    FrameLayout splash = new FrameLayout(this);
    ImageView logo = new ImageView(this);
    logo.setImageResource(com.feastly.restaurant.R.drawable.savrivo_icon);
    logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
    logo.setAlpha(0f);
    logo.setScaleX(.72f);
    logo.setScaleY(.72f);
    FrameLayout.LayoutParams logoParams = new FrameLayout.LayoutParams(dp(124), dp(124), Gravity.CENTER);
    logoParams.bottomMargin = dp(54);
    splash.addView(logo, logoParams);

    TextView title = new TextView(this);
    title.setText("SCRAVEIT  RESTAURANT");
    title.setTextColor(Color.rgb(161, 220, 255));
    title.setTextSize(17);
    title.setGravity(Gravity.CENTER);
    title.setLetterSpacing(.13f);
    title.setAlpha(0f);
    FrameLayout.LayoutParams titleParams = new FrameLayout.LayoutParams(dp(300), dp(34), Gravity.CENTER);
    titleParams.topMargin = dp(144);
    splash.addView(title, titleParams);

    TextView tag = new TextView(this);
    tag.setText("RUN YOUR RESTAURANT");
    tag.setTextColor(Color.rgb(104, 159, 205));
    tag.setTextSize(9);
    tag.setGravity(Gravity.CENTER);
    tag.setLetterSpacing(.10f);
    tag.setAlpha(0f);
    FrameLayout.LayoutParams tagParams = new FrameLayout.LayoutParams(dp(300), dp(24), Gravity.CENTER);
    tagParams.topMargin = dp(180);
    splash.addView(tag, tagParams);

    view.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView ignored, String url, Bitmap favicon) {
        trustedPageLoaded = false;
      }
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
        trustedPageLoaded = isTrustedPage(url);
        if (!trustedPageLoaded) return;
        if (pushBinder != null) pushBinder.onPageReady();
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
    // JavascriptInterface methods run on WebView's bridge worker. Reading WebView#getUrl there
    // throws a wrong-thread exception, so only use the main-thread callback state here.
    return webView != null && trustedPageLoaded;
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

  private class RestaurantBridge {
    @JavascriptInterface public void signInWithGoogle() {
      runOnUiThread(() -> {
        if (!isTrustedPageLoaded()) return;
        String clientId;
        try { clientId = getString(R.string.default_web_client_id); }
        catch (Exception error) { publishGoogleFailure("Google sign-in is not configured for this build."); return; }
        googleSignIn.start(clientId, new GoogleCredentialSignIn.Callback() {
          @Override public void onIdToken(String token) { publishGoogleToken(token); }
          @Override public void onFailure(String message) { publishGoogleFailure(message); }
        });
      });
    }
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
    @JavascriptInterface public void uploadPreparedImage(String requestId, String idToken,
                                                          String objectPath) {
      String safeRequestId = requestId == null ? "" : requestId.trim();
      String safeToken = idToken == null ? "" : idToken.trim();
      String safePath = objectPath == null ? "" : objectPath.trim();
      runOnUiThread(() -> beginPreparedImageUpload(safeRequestId, safeToken, safePath));
    }
  }

  private void publishGoogleToken(String token) {
    if (webView != null && isTrustedPageLoaded()) webView.evaluateJavascript(
        "window.googleIdTokenReceived&&window.googleIdTokenReceived(" + JSONObject.quote(token) + ")", null);
  }

  private void publishGoogleFailure(String message) {
    if (webView != null && isTrustedPageLoaded()) webView.evaluateJavascript(
        "window.googleSignInFailed&&window.googleSignInFailed(" + JSONObject.quote(message) + ")", null);
  }

  private void beginPreparedImageUpload(String requestId, String idToken, String objectPath) {
    if (!isTrustedPageLoaded()) {
      publishImageUpload(requestId, false, "Image upload is unavailable on this screen.");
      return;
    }
    File source = preparedImageFile;
    boolean validPath = objectPath.matches(
        "restaurants/[A-Za-z0-9_-]{1,128}/users/[A-Za-z0-9_-]{1,128}/(?:cover|menu/[A-Za-z0-9_-]{1,180})/[A-Za-z0-9_.-]{1,180}\\.jpg");
    if (!requestId.matches("[A-Za-z0-9_-]{1,80}") || idToken.length() < 20
        || idToken.length() > 8192 || !validPath || source == null || !source.isFile()) {
      publishImageUpload(requestId, false,
          "The prepared image is no longer available. Choose the image again.");
      return;
    }
    imageExecutor.execute(() -> {
      try {
        String downloadUrl = uploadImageToFirebase(source, idToken, objectPath);
        if (preparedImageFile == source) preparedImageFile = null;
        source.delete();
        publishImageUpload(requestId, true, downloadUrl);
      } catch (Exception error) {
        String message = error.getMessage();
        publishImageUpload(requestId, false, message == null || message.trim().isEmpty()
            ? "Firebase Storage could not upload this image." : message);
      }
    });
  }

  private String uploadImageToFirebase(File source, String idToken, String objectPath)
      throws IOException {
    int bucketId = getResources().getIdentifier("google_storage_bucket", "string", getPackageName());
    String bucket = bucketId == 0 ? "" : getString(bucketId).trim();
    if (!bucket.matches("[A-Za-z0-9.-]{3,255}")) {
      throw new IOException("Firebase Storage is not configured for this app.");
    }
    String downloadToken = UUID.randomUUID().toString();
    String endpoint = "https://firebasestorage.googleapis.com/v0/b/" + Uri.encode(bucket)
        + "/o?uploadType=media&name=" + Uri.encode(objectPath);
    HttpURLConnection connection = (HttpURLConnection)new URL(endpoint).openConnection();
    connection.setConnectTimeout(20000);
    connection.setReadTimeout(45000);
    connection.setRequestMethod("POST");
    connection.setDoOutput(true);
    connection.setFixedLengthStreamingMode(source.length());
    connection.setRequestProperty("Authorization", "Bearer " + idToken);
    connection.setRequestProperty("Content-Type", "image/jpeg");
    connection.setRequestProperty("X-Goog-Upload-Protocol", "raw");
    connection.setRequestProperty("X-Goog-Meta-FirebaseStorageDownloadTokens", downloadToken);
    try {
      try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(source));
           BufferedOutputStream output = new BufferedOutputStream(connection.getOutputStream())) {
        byte[] buffer = new byte[32 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        output.flush();
      }
      int status = connection.getResponseCode();
      InputStream responseStream = status >= 200 && status < 300
          ? connection.getInputStream() : connection.getErrorStream();
      String response = readUtf8(responseStream);
      if (status < 200 || status >= 300) {
        if (status == 401 || status == 403) {
          throw new IOException("Firebase Storage denied the upload. Check the published Storage rules.");
        }
        throw new IOException("Image upload failed (" + status + "). Please try again.");
      }
      if (!response.isEmpty()) {
        String serverToken = new JSONObject(response).optString("downloadTokens", "");
        if (!serverToken.isEmpty()) downloadToken = serverToken.split(",")[0];
      }
      return "https://firebasestorage.googleapis.com/v0/b/" + Uri.encode(bucket)
          + "/o/" + Uri.encode(objectPath) + "?alt=media&token=" + Uri.encode(downloadToken);
    } catch (org.json.JSONException error) {
      throw new IOException("Firebase returned an invalid upload response.", error);
    } finally {
      connection.disconnect();
    }
  }

  private String readUtf8(InputStream stream) throws IOException {
    if (stream == null) return "";
    try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
      return output.toString(StandardCharsets.UTF_8.name());
    }
  }

  private void publishImageUpload(String requestId, boolean ok, String value) {
    String safeId = requestId == null ? "" : requestId;
    String safeValue = value == null ? "" : value;
    runOnUiThread(() -> {
      if (webView == null || !isTrustedPageLoaded()) return;
      String script = "window.SavrivoRestaurantMediaCallbacks&&window.SavrivoRestaurantMediaCallbacks.resolve("
          + JSONObject.quote(safeId) + "," + ok + "," + JSONObject.quote(safeValue) + ")";
      webView.evaluateJavascript(script, null);
    });
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
        ? "window.restaurantLocationUnavailable&&window.restaurantLocationUnavailable()"
        : "window.restaurantLocationReceived&&window.restaurantLocationReceived(" + location.getLatitude()
          + "," + location.getLongitude() + ")";
    webView.post(() -> {
      if (isTrustedPageLoaded()) webView.evaluateJavascript(script, null);
    });
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
    Uri selected = resultCode == RESULT_OK && data != null ? data.getData() : null;
    if (!isTrustedPageLoaded() || selected == null) {
      completeFileChooser(null);
      return;
    }
    prepareSelectedImage(selected);
  }

  private void prepareSelectedImage(Uri source) {
    File previous = preparedImageFile;
    preparedImageFile = null;
    if (previous != null && previous.isFile()) previous.delete();
    imageExecutor.execute(() -> {
      File output = null;
      try {
        long sourceLength = sourceLength(source);
        if (sourceLength > MAX_SOURCE_IMAGE_BYTES) throw new IOException("Image is larger than 50 MB");
        Bitmap decoded = decodeImage(source);
        if (decoded == null || decoded.getWidth() < 1 || decoded.getHeight() < 1) {
          throw new IOException("Image could not be decoded");
        }
        Bitmap prepared = flattenAndResize(decoded, PREPARED_IMAGE_MAX_EDGE);
        if (prepared != decoded) decoded.recycle();
        File directory = new File(getCacheDir(), "savrivo-images");
        if (!directory.exists() && !directory.mkdirs()) {
          prepared.recycle();
          throw new IOException("Could not prepare image cache");
        }
        removeExpiredPreparedImages(directory);
        output = new File(directory, "restaurant-upload-" + System.currentTimeMillis() + ".jpg");
        try (FileOutputStream stream = new FileOutputStream(output)) {
          if (!prepared.compress(Bitmap.CompressFormat.JPEG, 88, stream)) {
            throw new IOException("Image compression failed");
          }
          stream.flush();
        } finally {
          prepared.recycle();
        }
        Uri preparedUri = FileProvider.getUriForFile(this,
            getPackageName() + ".fileprovider", output);
        preparedImageFile = output;
        grantUriPermission(getPackageName(), preparedUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        runOnUiThread(() -> completeFileChooser(preparedUri));
      } catch (Exception error) {
        if (output != null && output.exists()) output.delete();
        runOnUiThread(() -> {
          Toast.makeText(this,
              "This image is damaged or unsupported. Choose another photo or take a new one.",
              Toast.LENGTH_LONG).show();
          completeFileChooser(null);
        });
      }
    });
  }

  private long sourceLength(Uri source) {
    try (android.content.res.AssetFileDescriptor descriptor =
             getContentResolver().openAssetFileDescriptor(source, "r")) {
      return descriptor == null ? -1L : descriptor.getLength();
    } catch (Exception ignored) {
      return -1L;
    }
  }

  private Bitmap decodeImage(Uri source) throws IOException {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      ImageDecoder.Source decoderSource = ImageDecoder.createSource(getContentResolver(), source);
      return ImageDecoder.decodeBitmap(decoderSource, (decoder, info, ignored) -> {
        int width = info.getSize().getWidth();
        int height = info.getSize().getHeight();
        float scale = Math.min(1f, PREPARED_IMAGE_MAX_EDGE / (float)Math.max(width, height));
        decoder.setTargetSize(Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)));
        decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
        decoder.setMemorySizePolicy(ImageDecoder.MEMORY_POLICY_LOW_RAM);
      });
    }
    BitmapFactory.Options bounds = new BitmapFactory.Options();
    bounds.inJustDecodeBounds = true;
    try (InputStream stream = getContentResolver().openInputStream(source)) {
      if (stream == null) throw new IOException("Image is unavailable");
      BitmapFactory.decodeStream(stream, null, bounds);
    }
    if (bounds.outWidth < 1 || bounds.outHeight < 1) throw new IOException("Image dimensions are invalid");
    BitmapFactory.Options options = new BitmapFactory.Options();
    options.inPreferredConfig = Bitmap.Config.ARGB_8888;
    while (Math.max(bounds.outWidth / options.inSampleSize,
        bounds.outHeight / options.inSampleSize) > PREPARED_IMAGE_MAX_EDGE * 2) {
      options.inSampleSize *= 2;
    }
    try (InputStream stream = getContentResolver().openInputStream(source)) {
      if (stream == null) throw new IOException("Image is unavailable");
      Bitmap decoded = BitmapFactory.decodeStream(stream, null, options);
      if (decoded == null) throw new IOException("Image could not be decoded");
      return decoded;
    }
  }

  private Bitmap flattenAndResize(Bitmap source, int maxEdge) {
    float scale = Math.min(1f, maxEdge / (float)Math.max(source.getWidth(), source.getHeight()));
    int width = Math.max(1, Math.round(source.getWidth() * scale));
    int height = Math.max(1, Math.round(source.getHeight() * scale));
    Bitmap output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(output);
    canvas.drawColor(Color.WHITE);
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    canvas.drawBitmap(source, null, new RectF(0, 0, width, height), paint);
    return output;
  }

  private void removeExpiredPreparedImages(File directory) {
    File[] files = directory.listFiles();
    if (files == null) return;
    long cutoff = System.currentTimeMillis() - 24L * 60L * 60L * 1000L;
    for (File file : files) if (file.isFile() && file.lastModified() < cutoff) file.delete();
  }

  private void completeFileChooser(Uri value) {
    ValueCallback<Uri[]> callback = fileChooserCallback;
    fileChooserCallback = null;
    if (callback != null) callback.onReceiveValue(value == null ? null : new Uri[]{value});
  }

  @Override protected void onDestroy() {
    trustedPageLoaded = false;
    if (pushBinder != null) {
      pushBinder.close();
      pushBinder = null;
    }
    handler.removeCallbacksAndMessages(null);
    imageExecutor.shutdownNow();
    File prepared = preparedImageFile;
    preparedImageFile = null;
    if (prepared != null && prepared.isFile()) prepared.delete();
    if (fileChooserCallback != null) {
      fileChooserCallback.onReceiveValue(null);
      fileChooserCallback = null;
    }
    if (webView != null) {
      webView.removeJavascriptInterface("FeastlyRestaurantNative");
      webView.removeJavascriptInterface("SavrivoCloudNative");
      webView.stopLoading();
      webView.loadUrl("about:blank");
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }

  @Override protected void onStart() {
    super.onStart();
    if (pushBinder != null) pushBinder.onStart();
  }

  @Override protected void onStop() {
    if (pushBinder != null) pushBinder.onStop();
    super.onStop();
  }

  @Override protected void onResume() {
    super.onResume();
    if (pushBinder != null) pushBinder.publishPending();
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (pushBinder != null) pushBinder.onNewIntent(intent);
  }
}
