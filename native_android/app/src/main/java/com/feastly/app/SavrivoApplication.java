package com.feastly.app;

import android.app.Application;
import android.content.pm.ApplicationInfo;

import com.google.firebase.FirebaseApp;
import com.google.firebase.crashlytics.FirebaseCrashlytics;
import com.google.firebase.messaging.FirebaseMessaging;

/** Initializes security and reliability SDKs before the Customer UI uses Firebase. */
public final class SavrivoApplication extends Application {
  @Override public void onCreate() {
    super.onCreate();
    FirebaseApp app = FirebaseApp.initializeApp(this);
    if (app == null) return;

    boolean debugBuild = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    AppCheckProviderInstaller.install(app);

    FirebaseCrashlytics crashlytics = FirebaseCrashlytics.getInstance();
    crashlytics.setCrashlyticsCollectionEnabled(!debugBuild);
    crashlytics.setCustomKey("sav_app", "customer");
    crashlytics.setCustomKey("sav_build_type", debugBuild ? "debug" : "release");

    FirebaseMessaging.getInstance().setAutoInitEnabled(true);
    CustomerMessagingService.createNotificationChannels(this);
  }
}
