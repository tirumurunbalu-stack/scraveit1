# Scraveit Phase 2 candidate — 2026-08-25

This is an offline-built engineering candidate. No Firebase deployment or live-data mutation was performed while producing it.

## Installable developer APKs

- `Scraveit-Customer-DEVELOPER-TESTING.apk`
- `Scraveit-Admin-DEVELOPER-TESTING.apk`
- `Scraveit-Restaurant-DEVELOPER-TESTING.apk`
- `Scraveit-Rider-DEVELOPER-TESTING.apk`

These APKs use Android developer signing and are intended only for isolated testing. They are not Play Store release artifacts.

## Release bundles

- `Scraveit-Customer-UNSIGNED-NOT-UPLOAD-READY.aab`
- `Scraveit-Admin-UNSIGNED-NOT-UPLOAD-READY.aab`
- `Scraveit-Restaurant-UNSIGNED-NOT-UPLOAD-READY.aab`
- `Scraveit-Rider-UNSIGNED-NOT-UPLOAD-READY.aab`

The bundles passed release compilation, R8 and lint, but are unsigned. Do not upload them to Google Play. A final release requires the authorized Play upload key, final production configuration and closed-testing validation.

## Backend compatibility warning

The candidate contains client support for staged backend additions, including bounded Admin dashboard data and verified rider-arrival handover. Those additions were deliberately not deployed. Test them only after the matching staged Functions/rules/index changes have been reviewed and deployed to an isolated non-production Firebase project.

## Automated verification

- Backend: TypeScript typecheck, build and 216 tests passed.
- Four-app native/static suite: 592 assertions passed.
- Android: 370 Gradle tasks completed successfully across all four apps.
- Release lint: zero errors for Customer, Admin, Restaurant and Rider.
- Four developer APKs: ZIP integrity and Android signature verification passed.
- Four AABs: bundle assembly passed; bundles remain unsigned by design.

Physical-device end-to-end, killed-app push, background location, two-rider race and OEM battery testing remain required before any production release.
