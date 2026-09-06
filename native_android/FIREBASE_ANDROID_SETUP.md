# Savrivo Android Firebase production setup

The Admin, Restaurant, and Rider modules are registered in Firebase project `savrivo-app` and each module contains the downloaded `google-services.json`. The Google Services Gradle plugin selects the matching client by package:

| Module | Android package | Firebase Android app ID |
| --- | --- | --- |
| Admin | `com.feastly.admin` | `1:458592242638:android:864d1667f812909944b99f` |
| Restaurant | `com.feastly.restaurant` | `1:458592242638:android:d69ea767761f871044b99f` |
| Rider | `com.feastly.rider` | `1:458592242638:android:3cbc71f4fe5c308744b99f` |

`google-services.json` contains public Firebase client configuration, not a server credential. Never add a service-account key, PhonePe secret, or private signing key to an Android module.

## Required console and backend gates

Complete these before treating a release build as production-ready:

1. Deploy the Functions contracts documented in `functions/README.md` in region `asia-south1`, then verify `registerPushToken`, `unregisterPushToken`, `updateOrderStatus`, and `claimRiderOrder` with App Check enforcement.
2. Link the Firebase project to the Google Play apps. Add the Play App Signing SHA-256 certificate for all three packages to Firebase App Check and enable the Play Integrity provider. SHA-1 registration alone is not sufficient for App Check.
3. For local debug builds, copy the App Check debug token printed by Logcat into Firebase Console > App Check > Manage debug tokens. Debug tokens are for development only and must not be enabled in release builds.
4. Assign Admin users the server-side custom claim `savrivoRole=owner` or `savrivoRole=ops_admin`. An email address displayed as owner in the WebView does not grant callable access.
5. Send `RESTAURANT_NEW_ORDER`, `STOP_ORDER_ALARM`, `RIDER_ORDER_OFFER`, and `REMOVE_RIDER_OFFER` as high-priority **data-only** FCM messages. Use the same `alarmId` for restaurant start/stop and the same `orderId` for rider show/remove. Include `title` and `body` in `data` for start events.
6. Keep `/feastly/riderJobs/{riderId}` backend-owned and rider-readable. It is the Rider app's only assigned-order projection. Populate pickup details on assignment, and only add the exact customer name/drop address/items/payment/instructions after `Handed to rider`. Never project a raw phone number; add a temporary `contactProxy` only after number-masking is integrated.
7. Keep `/feastly/tracking/{orderId}/proximityEvidence` rider-writeable only under the validated rule. A trusted backend trigger must validate fresh evidence and perform any `Near you` or `Arrived` lifecycle transition. The Rider client no longer changes those statuses automatically from GPS.
8. Publish the notification-permission and foreground-service disclosures. The Restaurant alarm uses a media-playback foreground service; Rider tracking uses a location foreground service and must remain tied to an active assigned delivery.

Crashlytics collection is disabled for debuggable builds and enabled for non-debuggable builds. App Check uses the debug provider only in debug variants and Play Integrity in release variants.

## Build verification

Use Android Studio's bundled JDK 17 and an installed Android API 36 platform:

```sh
cd native_android
./gradlew :admin:lintRelease :admin:assembleRelease :admin:bundleRelease \
  :restaurant:lintRelease :restaurant:assembleRelease :restaurant:bundleRelease \
  :rider:lintRelease :rider:assembleRelease :rider:bundleRelease
node tests/validate_premium.js
```

The release bundles are generated under each module's `build/outputs/bundle/release/` directory. The project does not contain a production signing key; signing and Play upload credentials must stay in the release operator's secure environment.
