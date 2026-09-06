package com.feastly.app;

import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory;

/** Release builds attest the Play-distributed application with Play Integrity. */
final class AppCheckProviderInstaller {
  private AppCheckProviderInstaller() { }

  static void install(FirebaseApp app) {
    FirebaseAppCheck.getInstance(app).installAppCheckProviderFactory(
        PlayIntegrityAppCheckProviderFactory.getInstance());
  }
}
