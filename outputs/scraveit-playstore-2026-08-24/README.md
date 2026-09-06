# Scraveit Android release candidates

Build date: 2026-08-24 (Asia/Kolkata)

## Applications

| App | Package ID | Version | Min API | Target API |
|---|---|---:|---:|---:|
| Customer | `com.feastly.app` | 3.4.0 (50) | 23 | 36 |
| Admin | `com.feastly.admin` | 3.2.9 (49) | 23 | 36 |
| Restaurant | `com.feastly.restaurant` | 3.3.0 (44) | 23 | 36 |
| Partner | `com.feastly.rider` | 3.4.9 (63) | 23 | 36 |

The existing package IDs and Firebase namespace are intentionally unchanged so existing accounts, restaurants, orders, notifications, and tracking records remain compatible.

## Which files to use

- `*-INSTALLABLE-TEST.apk`: signed developer builds for installation and final real-device regression testing. These are not Google Play submission files.
- `*-PLAYSTORE-UNSIGNED.aab`: optimized, minified release bundles. Google Play accepts Android App Bundles, not these testing APKs. Sign each AAB with the protected production upload key before uploading it to Play Console.

## Verification performed

- 526 cross-app premium and lifecycle assertions passed.
- Every registered route in all four apps booted successfully.
- 46 backend tests covering orders, restaurant transitions, rider dispatch, tracking, notifications, security, and payments passed.
- TypeScript type checking and production compilation passed.
- Android release lint passed for all four apps with no blocking errors.
- Debug APK signature verification passed for all four installable files.
- Release builds use R8 minification and resource shrinking.
- Customer cached Home rendered before network in the performance smoke test.

## Integrity

Verify copied artifacts with:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

## Required before Play Store upload

1. Use the permanent production upload key and enable/confirm Play App Signing.
2. Register the Google Play App Signing SHA-1 and SHA-256 fingerprints in Firebase for every package using Google Sign-In or App Check.
3. Complete Play Console Data Safety, privacy-policy, account-deletion, content-rating, ads, and app-access declarations.
4. Upload the AAB to an internal testing track first and run a real customer → restaurant → rider → delivery regression test from the Play-installed build.
5. For the Partner app, complete background-location and foreground-service declarations with review evidence.
