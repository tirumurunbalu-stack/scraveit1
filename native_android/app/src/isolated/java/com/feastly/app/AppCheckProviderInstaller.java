package com.feastly.app;

import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory;

/** Isolated builds generate their own test-device token; no production debug token is reused. */
final class AppCheckProviderInstaller {
  private AppCheckProviderInstaller() { }

  static void install(FirebaseApp app) {
    FirebaseAppCheck.getInstance(app).installAppCheckProviderFactory(
        DebugAppCheckProviderFactory.getInstance());
  }
}
