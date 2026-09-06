# Scraveit Android staging build — install and test

Scraveit is split into **four Android apps** over the same Firebase project:

1. **Scraveit Customer** — discovery, ordering, addresses and live tracking.
2. **Scraveit Admin** — platform-owner operations, approvals and overrides.
3. **Scraveit Restaurant** — restaurant owner/manager/staff daily operations.
4. **Scraveit Rider** — rider onboarding, delivery workflow, navigation and live location.

All modules target Android API 36 and Android 6.0+ (min API 23).

## Current staging window

From **August 25, 2026 through September 1, 2026**, the current Firebase project
`savrivo-app` is the official **staging/sandbox** environment for physical-device
testing, synthetic orders, alarms, dispatch, COD accounting and end-to-end validation.

- Treat every installed build from the current committed Firebase config as a staging build.
- Use **dedicated test devices only**; the package identities stay unchanged:
  - Customer: `com.feastly.app`
  - Restaurant: `com.feastly.restaurant`
  - Rider: `com.feastly.rider`
  - Admin: `com.feastly.admin`
- Use fresh prefixed synthetic accounts and data. Do not use real customer financial data.
- The separate `isolated` build path remains reserved for future clean-project testing and for the
  post-September-1 production migration path. It is not the active path for this staging window.

## Build on the development Mac

Install these pinned prerequisites in Android Studio's SDK Manager:

- Android SDK Platform 36;
- Android SDK Build Tools 36.0.0;
- a JDK from 17 through 25 (the current Android Studio bundled JDK is supported).

For the current staging sandbox path, from the repository root:

```sh
native_android/tests/run.sh
native_android/build_staging_sandbox.sh
```

This validates that the committed Android and WebView Firebase config still targets the intended
staging project, then builds debug-signed APKs for all four apps.

Expected output directory:

```text
native_android/build/savrivo_staging_sandbox/
```

Expected artifact names:

```text
Scraveit-Customer-STAGING-SANDBOX-debug.apk
Scraveit-Restaurant-STAGING-SANDBOX-debug.apk
Scraveit-Rider-STAGING-SANDBOX-debug.apk
Scraveit-Admin-STAGING-SANDBOX-debug.apk
```

The older generic build path still exists for local engineering use:

```sh
native_android/build_savrivo.sh --release-bundles
```

Release AABs are deliberately unsigned. Do not commit a private key or password. Sign the Customer and Partner release bundles with a separately protected Play upload key in CI or Android Studio, then let Play App Signing protect the distribution key.

Individual release tasks are also available:

```sh
cd native_android
./gradlew :customer:bundleRelease
./gradlew :rider:bundleRelease
```

Run the complete four-app release gate directly with `./gradlew verifyProduction`.

## Device installation for physical staging tests

Enable USB debugging on the dedicated Android devices and connect them to this Mac. Then export
the target serials and install the staging APKs:

```sh
# Two-phone staging mode
export SCRAVEIT_PHONE1_SERIAL='<adb-serial>'   # Customer + Restaurant + Admin
export SCRAVEIT_PHONE2_SERIAL='<adb-serial>'   # Rider

native_android/tools/staging_device_preflight.sh \
  native_android/build/savrivo_staging_sandbox

native_android/tools/install_staging_apks.sh \
  native_android/build/savrivo_staging_sandbox

# Legacy multi-device staging mode
export SCRAVEIT_CUSTOMER_SERIAL='<adb-serial>'
export SCRAVEIT_RESTAURANT_SERIAL='<adb-serial>'
export SCRAVEIT_RIDER_A_SERIAL='<adb-serial>'
export SCRAVEIT_RIDER_B_SERIAL='<adb-serial>'
export SCRAVEIT_ADMIN_SERIAL='<adb-serial>'   # optional

native_android/tools/staging_device_preflight.sh \
  native_android/build/savrivo_staging_sandbox

native_android/tools/install_staging_apks.sh \
  native_android/build/savrivo_staging_sandbox
```

The script uses the local Android platform-tools `adb`, verifies that each required device is
attached and authorized, then reinstalls the matching staging APK. Rider A and Rider B both use
the same Rider build. In two-phone mode, Phone 1 receives Customer + Restaurant + Admin and
Phone 2 receives Rider; the true simultaneous two-rider race still needs a third phone later.
The preflight script records device models, Android versions, package installation state and APK
hashes into `native_android/build/savrivo_staging_preflight/`.

For the complete staging phone-by-phone execution sequence, use:

```text
outputs/SCRAVEIT_STAGING_PHYSICAL_E2E_RUNBOOK_2026-08-25.md
```

## Customer Google sign-in staging gate

The Customer app uses Android Credential Manager and exchanges a Google ID token with Firebase
Authentication. For the current staging sandbox:

1. In Firebase project `savrivo-app`, enable **Authentication → Sign-in method → Google** and select a support email.
2. Add the SHA-1 for every certificate that can sign an installed Customer app:
   - local debug: run `cd native_android && ./gradlew :customer:signingReport`;
   - Play production/internal/closed tracks: copy the **App signing key certificate SHA-1** from Play Console → Setup → App integrity;
   - add any separate internal-app-sharing signing certificate if that channel is used.
3. Download a fresh `google-services.json` for Android package `com.feastly.app` and replace `native_android/app/google-services.json`.
4. Confirm the file contains a Web OAuth client. Gradle generates `default_web_client_id` from that client; the app never hard-codes a client ID.

The upload certificate and Play app-signing certificate are not necessarily the same. Registering
only the upload SHA-1 will make Google sign-in fail in the Play-installed app. Certificate
fingerprints are safe to register; private keys and passwords must never be shared or committed.

## First integrated test

1. Run `native_android/tests/run.sh`; do not continue if it fails.
2. Build the current staging APKs with `native_android/build_staging_sandbox.sh`.
3. Install the APKs on the dedicated Customer, Restaurant, Rider A, Rider B and optional Admin devices.
4. Sign in to Scraveit Admin as the staging platform owner.
5. Create or verify a synthetic restaurant and provision a Restaurant account for it.
6. Sign in to Scraveit Restaurant and verify only the assigned restaurant is visible.
7. Add or edit a synthetic menu item, upload a photo, change price and toggle availability. Confirm Customer receives the normalized menu update.
8. Toggle the restaurant offline briefly. Confirm Customer immediately treats it as unavailable; restore online.
9. In Customer, add a delivery address using the tappable map pin or phone location, then place a COD test order.
10. In Restaurant, accept → preparing → ready for pickup. Confirm the delivery appears to eligible Rider users.
11. Put Rider A and Rider B online. Attempt a near-simultaneous claim from both devices; only one fresh claim should win.
12. Navigate to restaurant, confirm handover, navigate to customer, and verify the Customer tracking view updates from the foreground GPS service.
13. Complete delivery with the verification flow and confirm it appears in history, Admin, COD exposure, rider earnings and restaurant settlement views.

## Important production gates

The repository is substantially safer than the previous developer build, but do **not** take real
online payments yet. Production launch still requires trusted server-side price/payment
verification, payment-gateway webhooks, production push delivery, Firebase emulator/rules testing,
real-device QA, release signing, legal/privacy pages, monitoring, a fresh production Firebase
project after September 1, and a controlled production deployment sequence.
