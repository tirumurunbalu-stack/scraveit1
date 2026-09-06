package com.feastly.admin;

import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory;

/** Isolated builds generate their own test-device token; no production debug token is reused. */
public final class AppCheckProviderInstaller {
    private AppCheckProviderInstaller() { }

    public static void install(FirebaseApp app) {
        FirebaseAppCheck.getInstance(app).installAppCheckProviderFactory(
                DebugAppCheckProviderFactory.getInstance());
    }
}
