# Savrivo production readiness

Status: engineering release candidate in progress. This document intentionally distinguishes implemented code from services that still require credentials, legal approval, deployment, or physical-device verification.

## Product architecture

- Customer Android app: `com.feastly.app`
- Rider Android app: `com.feastly.rider`
- Restaurant Android app: `com.feastly.restaurant`
- Admin Android app: `com.feastly.admin`
- Firebase project: `savrivo-app`
- Realtime Database compatibility namespace: `/feastly`
- Cloud Functions region: `asia-south1`

All existing customer, order, restaurant, rider, tracking, membership, settlement and support history remains under the existing `/feastly` namespace. Migrations must archive operational records instead of deleting history.

## Completed in this production pass

- Audited the four supplied APKs against the source modules.
- Replaced the retired Customer Google OAuth bridge with Android Credential Manager and Firebase-compatible Google ID-token exchange.
- Added a pinned Gradle/App Bundle build path with no signing password or private key in source.
- Removed unreachable packaged shells, stale patch assets and retired demo restaurant media.
- Added a server-authoritative Firebase Functions foundation for COD pricing/order creation, lifecycle transitions, rider dispatch, notifications, COD ledger and a fail-closed PhonePe adapter.
- Hardened Firebase Realtime Database and Storage schemas while preserving the `/feastly` data model.
- Added safe catalogue/menu dual-write behavior and Firebase Storage uploads for Admin-managed restaurant, food and banner images.
- Added cart recovery when a restaurant is archived.
- Added repeatable automated boot, route, asset, schema and security-contract checks.
- Removed 178 obsolete APK/IDSIG build artifacts (153.12 MiB) from the retired backup/output locations without touching source, documents, archives or canonical Gradle outputs.
- Created a labeled release-candidate snapshot with four developer/testing APKs, four unsigned release AABs, integrity hashes and package metadata under `outputs/release-candidate/`.
- Registered separate Firebase Android applications for Customer, Rider, Restaurant and Admin in the `savrivo-app` project, then added the current debug and legacy developer signing fingerprints for device testing.
- Deployed the validated Realtime Database rules to `savrivo-app` after saving the previous live rules under `firebase/backups/`; no Functions, paid API, billing or payment configuration was deployed.

## Binary cleanup and artifact snapshot

The exact cleanup scope and result are recorded in `outputs/BINARY_CLEANUP_REPORT.md`. The release-candidate directory contains SHA-256 checksums and a usage warning that distinguishes installable debug APKs from unsigned Play release bundles.

The current debug APK snapshot is signed with isolated-build certificate SHA-1 `B7:DA:CB:B0:31:3D:B1:97:9D:C2:08:D0:34:B1:E5:12:44:8A:FF:06`. That testing fingerprint is now registered in Firebase for all four Android applications. Production must still use and register the final Google Play App Signing certificate.

## Live catalogue migration

The prior `savrivo-main` restaurant is archived (`open=false`, `archived=true`) in `savrivo-app`; it was not deleted, so historical orders remain readable.

The staged replacement is `the-waffle-spot-naidupeta` with:

- Name: The Waffle Spot
- Location: Pichi Reddy Thopu, Near Current Office, Naidupeta, Andhra Pradesh 524126
- Coordinates: `13.9018832, 79.8877264`
- Cuisines: Waffle, Pancake, Desserts
- State: closed until owner confirmation
- Menu: 14 publicly listed Creamora ice-cream records, all unavailable until owner confirmation

Backups and exact multi-location patch previews are stored under `firebase/backups/`. The generated catalogue migration is repeatable and refuses any Firebase project other than `savrivo-app`.

## Firebase changes

Implemented locally:

- Realtime Database rules: `firebase/feastly-realtime-database-rules.json`
- Staged Functions rollout rules (not active/deployed): `firebase/feastly-realtime-database-rules.production-functions-stage1.json`
- Isolated stage-1 database deployment config: `firebase/firebase.production-functions-stage1.json`
- Functions rules contract validator: `firebase/tests/validate-functions-rules.mjs`
- Storage rules: `firebase/storage.rules`
- Safe catalogue migration: `firebase/migrations/stage-waffle-spot.mjs`
- Server backend: `functions/`
- Explicit project selection: `.firebaserc`

Implemented in the Firebase project:

- Customer: `com.feastly.app`
- Rider: `com.feastly.rider`
- Restaurant: `com.feastly.restaurant`
- Admin: `com.feastly.admin`
- Current testing SHA-1 and legacy developer SHA-1 registered for the applicable Android apps
- Google sign-in provider enabled for the Customer app
- Current Realtime Database rules deployed and semantically verified against the local rules file

The Functions backend and any new native Firebase SDK integrations must be staged and tested before deployment. Deploying Functions can consume Blaze-plan resources and is not performed implicitly.

## Required external services and keys

These values must come from the business/provider; they must never be invented or committed:

- Google Play Console developer account, application records and Play App Signing certificates
- Production upload keystore held outside the repository
- PhonePe merchant ID, salt/key material, callback configuration and settlement account
- Google Weather API billing-enabled restricted server credential, or another approved weather provider
- Exotel, Twilio or Knowlarity account and approved number-masking configuration
- Owner-confirmed restaurant hours, exact menu, prices, availability, FSSAI/GST details and licensed photos
- Legal business name, support contact, Privacy Policy, Terms, refund/cancellation policy, rider agreement and restaurant agreement
- Google Play Data safety answers, account-deletion website and Rider foreground/background-location declaration video

## Release commands

From `native_android/`:

```bash
./gradlew clean verifyProduction
./gradlew :customer:assembleDebug :customer:bundleRelease
./gradlew :rider:assembleDebug :rider:bundleRelease
```

From the repository root:

```bash
bash native_android/tests/run.sh
node firebase/tests/validate-functions-rules.mjs
npm --prefix functions ci
npm --prefix functions run typecheck
npm --prefix functions test
npm --prefix functions run build
```

Production signing must be injected through local/CI secrets. Debug APKs are for device testing only; unsigned release AABs are not Play-upload deliverables.

## Callable backend and rules deployment sequence

The active rules file remains unchanged while the apps still contain legacy direct writes. Use this order; skipping directly to the final lock-down would stop ordering or fulfilment for installed builds.

1. Export the complete live `/feastly` tree and the live RTDB rules. Record restore commands and verify the export opens.
2. Validate `firebase/feastly-realtime-database-rules.production-functions-stage1.json` with `node firebase/tests/validate-functions-rules.mjs`, Firebase Emulator Suite tests, and a non-production project.
3. Configure production App Check for all four registered Android apps, FCM, Cloud Tasks IAM and Functions runtime secrets. Keep PhonePe fail-closed until contracted credentials and callback verification exist.
4. Deploy the Functions backend first. Do not change app traffic yet; verify idempotent retry, mirror reconciliation, simultaneous rider claims, alarm start/stop delivery and COD ledger behavior in staging.
5. After approval, explicitly deploy stage 1 with `firebase deploy --only database --config firebase/firebase.production-functions-stage1.json --project savrivo-app`. It locks only Functions-exclusive records; default `firebase deploy --only database` still targets the current compatibility file and therefore cannot publish stage 1 accidentally.
6. Release compatible Customer, Restaurant, Rider and Admin builds in a controlled internal/closed track. They must use `createCodOrder`, `updateOrderStatus`, `claimRiderOrder`, `registerPushToken` and `unregisterPushToken` as applicable.
7. Monitor callable success/error rates, App Check rejection, FCM delivery, Cloud Tasks depth, order/mirror reconciliation and client-version adoption. Exercise the documented rollback before broad rollout.
8. Only when legacy versions are below the approved adoption threshold, create and emulator-test stage 2: orders/status/assignment, restaurant mirrors, dispatch queues, rider jobs and audit become server-write-only; rider presence is narrowed to heartbeat fields while assigned-order state stays backend-owned.
9. Deploy stage 2 during a monitored maintenance window. Preserve all existing read rules and order/history records; never delete data as part of a rules migration.

## Play Store gate

- [ ] Customer and Rider release AABs signed by the final upload key
- [ ] Play App Signing SHA-1 and SHA-256 registered in Firebase/Google OAuth
- [ ] Google sign-in verified on a Play-installed internal-test build
- [ ] Customer account deletion works in-app and from a public HTTPS page
- [ ] Privacy Policy and support URL are public and client-approved
- [ ] Rider location disclosure, permission sequence and foreground-service declaration approved
- [ ] Data safety form matches actual Firebase, location, KYC, payment and analytics behavior
- [ ] PhonePe production callbacks verified server-to-server
- [ ] Crash reporting, analytics and push notifications verified in release builds
- [ ] Closed testing completed on low-memory Android 6+, Android 10, Android 13 and Android 16 devices
- [ ] Accessibility, slow/offline network, rotation, keyboard, process-death and battery-optimization tests passed

## Known release blockers

- PhonePe, weather and number masking cannot be activated without provider credentials/contracts.
- Final restaurant media/menu/hours require owner authorization.
- No attached Android device or emulator image is available in the current workspace, so physical-device and Play-installed Google sign-in tests remain mandatory.
- Play Console publication cannot proceed without the client's developer account, final legal pages, store listing assets and signing decision.
