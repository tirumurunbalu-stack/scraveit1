package com.feastly.app;

import android.app.Application;
import android.content.pm.ApplicationInfo;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.AppCheckProviderFactory;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.crashlytics.FirebaseCrashlytics;
import com.google.firebase.messaging.FirebaseMessaging;

/** Initializes security and reliability SDKs before the Customer UI uses Firebase. */
public final class SavrivoApplication extends Application {
  private static final String TAG = "SavrivoApplication";

  @Override public void onCreate() {
    super.onCreate();
    FirebaseApp app = FirebaseApp.initializeApp(this);
    if (app == null) return;

    boolean debugBuild = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    installAppCheck(app, debugBuild);

    FirebaseCrashlytics crashlytics = FirebaseCrashlytics.getInstance();
    crashlytics.setCrashlyticsCollectionEnabled(!debugBuild);
    crashlytics.setCustomKey("sav_app", "customer");
    crashlytics.setCustomKey("sav_build_type", debugBuild ? "debug" : "release");

    FirebaseMessaging.getInstance().setAutoInitEnabled(true);
    CustomerMessagingService.createNotificationChannels(this);
  }

  /**
   * Installs the App Check provider using the same strategy as SavrivoFirebase:
   * a build-variant source-set class (debug/release/isolated) is preferred when
   * present; otherwise the correct factory is loaded reflectively so a missing
   * gitignored debug installer never breaks the build.
   */
  private void installAppCheck(FirebaseApp app, boolean debugBuild) {
    try {
      Class<?> installer = Class.forName(getPackageName() + ".AppCheckProviderInstaller");
      installer.getMethod("install", FirebaseApp.class).invoke(null, app);
      return;
    } catch (ClassNotFoundException ignored) {
      // No variant-specific installer; fall through to standard factory.
    } catch (Exception error) {
      Log.e(TAG, "Variant App Check installer failed.", error);
    }
    try {
      String providerClass = debugBuild
          ? "com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory"
          : "com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory";
      Object factory = Class.forName(providerClass).getMethod("getInstance").invoke(null);
      FirebaseAppCheck.getInstance(app)
          .installAppCheckProviderFactory((AppCheckProviderFactory) factory);
    } catch (Exception error) {
      Log.e(TAG, "App Check provider initialization failed.", error);
    }
  }
}
