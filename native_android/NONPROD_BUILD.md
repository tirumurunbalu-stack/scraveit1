# Isolated Android build boundary

Production remains the default for the existing `debug` and `release` variants. The `isolated`
variant is an explicit, fail-closed path for testing all four apps against one separate Firebase
project. It keeps these production package identities unchanged:

- Customer: `com.feastly.app`
- Restaurant: `com.feastly.restaurant`
- Rider: `com.feastly.rider`
- Admin: `com.feastly.admin`

Because the identities stay unchanged, install these APKs only on dedicated test devices. An
isolated APK can replace the corresponding production/developer installation on a device.

## External inputs

Register all four package names as Android apps in one non-production Firebase project. Download
one `google-services.json` per app and place the files outside this repository:

```text
/absolute/private/firebase-config/
  customer/google-services.json
  restaurant/google-services.json
  rider/google-services.json
  admin/google-services.json
```

The gate requires all four files, verifies the exact package names, requires one shared project,
and rejects project ID `savrivo-app`. It also rejects production database/storage references. The
WebView Firebase configuration and database CSP origin are generated from those selected files in
`native_android/build/generated/`; they are not committed.

Each downloaded file must include a Web OAuth client (`oauth_client.client_type == 3`). This is
created by configuring Google sign-in for the isolated Firebase project; the build rejects a file
without it instead of compiling an app whose Google sign-in resource is silently missing. Enable
only the authentication providers needed for testing in that isolated project.

The `isolated` variants use Firebase's debug App Check provider without any committed debug token.
On first launch, each dedicated test device/app installation generates a debug token. If App Check
enforcement is enabled in the isolated Firebase project, register only those generated tokens in
that isolated project. Never copy a production token into this build path.

## Verify and build

Use JDK 17 or the Android Studio runtime, then run:

```bash
cd /Users/balu/Documents/Codex/2026-08-14/i-n/native_android

./gradlew verifyNonProdConfiguration \
  -PscraveitNonProdConfigDir=/absolute/private/firebase-config

./gradlew verifyNonProd \
  -PscraveitNonProdConfigDir=/absolute/private/firebase-config
```

`verifyNonProd` validates the boundary, generates the isolated WebView assets, runs isolated lint,
builds all four debug-signed test APKs, and then inspects the packaged APK resource table and
WebView assets. The build fails if either side contains `savrivo-app` or if their selected projects
do not match. `assembleNonProd` performs the same packaged-config gate without lint. The config
directory may instead be supplied as `SCRAVEIT_NONPROD_FIREBASE_DIR`.

Expected APK locations:

```text
app/build/outputs/apk/isolated/customer-isolated.apk
restaurant/build/outputs/apk/isolated/restaurant-isolated.apk
rider/build/outputs/apk/isolated/rider-isolated.apk
admin/build/outputs/apk/isolated/admin-isolated.apk
```

This task does not create Firebase projects, deploy Functions/rules, or modify data. For a full
end-to-end isolated environment, deploy the already staged backend and rules only after separate
authorization, configure the backend in `asia-south1`, register isolated App Check debug tokens if
enforcement is enabled there, and use test-only Maps/payment credentials.

Normal production commands such as `bundleProduction` and `verifyProduction` are unchanged and do
not read the isolated configuration directory.
