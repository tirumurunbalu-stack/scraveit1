# Scraveit production candidate — 24 August 2026

This directory contains one freshly rebuilt, internally verified release candidate for each Android application. The application IDs and Firebase project linkage were preserved.

## Status

The AAB files are deliberately labelled `UNSIGNED-NOT-UPLOAD-READY`. They passed the consolidated production build and release lint, but must not be uploaded to Google Play until all release gates below are complete.

## Required release gates

1. Sign each AAB with the protected Play upload key.
2. Register and verify the final Play App Signing SHA-1 and SHA-256 fingerprints for Firebase Authentication, Firebase App Check and Google Maps.
3. Configure a restricted Android Maps API key for `com.feastly.app`.
4. Revoke and rotate developer App Check debug identities before production launch.
5. Publish public privacy, terms, refund/cancellation and account-deletion pages.
6. Complete Google Play Internal Testing for login, App Check, maps, FCM, alarms, background rider tracking, checkout, restaurant acceptance, rider assignment, delivery, ratings and financial reconciliation.

## Included evidence

- `aab/`: unsigned release candidates.
- `mapping/`: R8/Crashlytics symbol mapping files that must be archived with the release.
- `lint/`: release lint reports for all four applications.
- `SHA256SUMS`: integrity hashes for every included artifact.

Do not substitute similarly named APK/AAB files elsewhere in the workspace; many are historical developer builds.
