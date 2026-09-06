package com.savrivo.firebase;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.appcheck.AppCheckProviderFactory;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.crashlytics.FirebaseCrashlytics;

import java.util.List;

/**
 * Initializes the native Firebase SDK without embedding an invented Android app id.
 *
 * <p>Production builds normally initialize through google-services.json. A CI build can instead
 * provide the same public Firebase options through the manifest placeholders documented in
 * FIREBASE_ANDROID_SETUP.md. If neither source is complete, cloud operations fail closed while
 * the rest of the application remains usable for local UI verification.</p>
 */
public final class SavrivoFirebase {
    private static final String TAG = "SavrivoFirebase";
    private static final String META_APP_ID = "com.savrivo.firebase.APP_ID";
    private static final String META_API_KEY = "com.savrivo.firebase.API_KEY";
    private static final String META_PROJECT_ID = "com.savrivo.firebase.PROJECT_ID";
    private static final String META_ROLE = "com.savrivo.firebase.APP_ROLE";
    private static final String META_REGION = "com.savrivo.firebase.FUNCTIONS_REGION";

    private static final Object LOCK = new Object();
    private static volatile FirebaseApp app;
    private static volatile String configurationError = "";

    private SavrivoFirebase() { }

    public static FirebaseApp ensureInitialized(Context context) {
        if (app != null) return app;
        synchronized (LOCK) {
            if (app != null) return app;
            Context application = context.getApplicationContext();
            try {
                List<FirebaseApp> existing = FirebaseApp.getApps(application);
                if (!existing.isEmpty()) {
                    app = FirebaseApp.getInstance();
                } else {
                    FirebaseApp automatic = FirebaseApp.initializeApp(application);
                    if (automatic != null) app = automatic;
                }
            } catch (Exception ignored) {
                // The explicit, build-property based boundary below is the supported fallback.
            }

            if (app == null) {
                Bundle metadata = metadata(application);
                String appId = string(metadata, META_APP_ID);
                String apiKey = string(metadata, META_API_KEY);
                String projectId = string(metadata, META_PROJECT_ID);
                if (appId.isEmpty() || apiKey.isEmpty() || projectId.isEmpty()) {
                    configurationError = "FIREBASE_ANDROID_APP_NOT_REGISTERED";
                    Log.w(TAG, "Firebase native services are disabled until this Android package is registered.");
                    return null;
                }
                try {
                    FirebaseOptions options = new FirebaseOptions.Builder()
                            .setApplicationId(appId)
                            .setApiKey(apiKey)
                            .setProjectId(projectId)
                            .build();
                    app = FirebaseApp.initializeApp(application, options);
                } catch (Exception error) {
                    configurationError = "FIREBASE_INITIALIZATION_FAILED";
                    Log.e(TAG, "Firebase native initialization failed.", error);
                    return null;
                }
            }

            boolean debuggable = (application.getApplicationInfo().flags
                    & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            try {
                // A sideloaded developer APK cannot use Play Integrity. Its debug-only source
                // set may provide an explicitly registered App Check identity. The class is
                // intentionally absent from release builds so the debug secret can never be
                // packaged in a Play bundle.
                boolean variantInstalled = debuggable && installDebugVariantProvider(application, app);
                if (!variantInstalled) {
                    String providerClass = debuggable
                            ? "com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory"
                            : "com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory";
                    Object configuredProvider = Class.forName(providerClass)
                            .getMethod("getInstance")
                            .invoke(null);
                    if (!(configuredProvider instanceof AppCheckProviderFactory)) {
                        throw new IllegalStateException("APP_CHECK_PROVIDER_INVALID");
                    }
                    AppCheckProviderFactory provider = (AppCheckProviderFactory) configuredProvider;
                    FirebaseAppCheck.getInstance(app).installAppCheckProviderFactory(provider);
                }
            } catch (Exception error) {
                Log.e(TAG, "App Check provider initialization failed.", error);
            }
            try {
                FirebaseCrashlytics crashlytics = FirebaseCrashlytics.getInstance();
                crashlytics.setCrashlyticsCollectionEnabled(!debuggable);
                crashlytics.setCustomKey("savrivo_app_role", appRole(application));
            } catch (Exception error) {
                Log.w(TAG, "Crashlytics is unavailable until Firebase configuration is complete.", error);
            }
            configurationError = "";
            return app;
        }
    }

    public static String configurationError(Context context) {
        ensureInitialized(context);
        return configurationError.isEmpty() ? "FIREBASE_CONFIGURATION_MISSING" : configurationError;
    }

    public static String appRole(Context context) {
        return string(metadata(context), META_ROLE);
    }

    public static String projectId(Context context) {
        FirebaseApp initialized = ensureInitialized(context);
        if (initialized != null && initialized.getOptions().getProjectId() != null) {
            return initialized.getOptions().getProjectId();
        }
        return string(metadata(context), META_PROJECT_ID);
    }

    public static String functionsRegion(Context context) {
        String region = string(metadata(context), META_REGION);
        return region.matches("[a-z0-9-]{2,40}") ? region : "asia-south1";
    }

    private static boolean installDebugVariantProvider(Context context, FirebaseApp firebaseApp) {
        try {
            Class<?> installer = Class.forName(context.getPackageName() + ".AppCheckProviderInstaller");
            installer.getMethod("install", FirebaseApp.class).invoke(null, firebaseApp);
            return true;
        } catch (ClassNotFoundException missing) {
            return false;
        } catch (Exception error) {
            Log.e(TAG, "Debug App Check identity initialization failed.", error);
            return false;
        }
    }

    private static Bundle metadata(Context context) {
        try {
            ApplicationInfo info = context.getPackageManager().getApplicationInfo(
                    context.getPackageName(), PackageManager.GET_META_DATA);
            return info.metaData == null ? Bundle.EMPTY : info.metaData;
        } catch (Exception error) {
            return Bundle.EMPTY;
        }
    }

    private static String string(Bundle bundle, String key) {
        Object value = bundle == null ? null : bundle.get(key);
        return value == null ? "" : String.valueOf(value).trim();
    }
}
