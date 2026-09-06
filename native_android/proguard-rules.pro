# WebView invokes these methods by name from packaged JavaScript.
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# The Google ID SDK reconstructs its credential from an Android Bundle.
-keep class com.google.android.libraries.identity.googleid.** { *; }

# Admin, Restaurant, and Rider install the release App Check provider through
# the shared Firebase bootstrap using its fully-qualified class name. Preserve
# the provider name and factory method so R8 cannot remove that production-only
# implementation from minified Play bundles.
-keep class com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory { *; }
