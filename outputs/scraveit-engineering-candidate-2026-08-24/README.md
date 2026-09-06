# Scraveit verified engineering candidate — 2026-08-24

These four Android App Bundles were produced by one clean `verifyProduction` run after the backend, security, ratings, finance, and release-hardening changes were integrated.

## Application identities

| App | Application ID | Version | Version code |
|---|---|---:|---:|
| Customer | `com.feastly.app` | 3.4.2 | 52 |
| Admin | `com.feastly.admin` | 3.3.0 | 50 |
| Restaurant | `com.feastly.restaurant` | 3.3.1 | 45 |
| Rider | `com.feastly.rider` | 3.5.0 | 64 |

## Important release status

The AABs are verified engineering outputs, but they are deliberately named `UNSIGNED-NOT-UPLOAD-READY` because the protected production upload key is not present in the workspace.

The Customer bundle also has Maps disabled because `SAVRIVO_MAPS_ANDROID_API_KEY` has not been supplied. Do not upload these exact files to Google Play. First inject a restricted Maps key, rebuild, sign with the approved Play upload key, register the final Play signing fingerprints in Firebase/App Check/Google OAuth, and rerun the release checks.

No debug App Check provider or developer attestation identity is packaged in these release bundles. All four bundles use the production Play Integrity dependency.

## Verification result

- Android behavior and packaging contract: 577 assertions passed.
- Full production Gradle gate: 205 tasks executed, build successful.
- Release lint: Customer 0 errors/3 warnings; Admin 0/22; Restaurant 0/17; Rider 0/22.
- Cloud Functions: typecheck/build passed; 30 test files and 178 tests passed.
- Firebase staged rules: stages 1–5 and the server-authority contract passed.

Mapping files must be retained for Crashlytics and de-obfuscating each exact release build. The SHA-256 manifest identifies every file in this folder.

