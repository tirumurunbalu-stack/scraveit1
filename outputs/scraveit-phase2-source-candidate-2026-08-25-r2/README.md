# Scraveit Phase 2 current-source build evidence — revision 2

Built on 2026-08-25 from the current Phase 2 source state.

## Important boundaries

- No Firebase deployment was performed and no live production data was read or changed.
- The APKs in this directory are Android debug-signed, production-configured local inspection builds. Do not use them for synthetic/destructive testing and do not submit them to Google Play.
- The AABs are unsigned build outputs. They are not upload-ready until the authorized Play upload key, final external configuration and physical closed-testing validation are available.
- No physical Android device or emulator was attached, so this package does not claim a hardware end-to-end pass.
- The verified fail-closed `isolated` build type requires four matching non-production Firebase Android configurations. Synthetic verification files and APKs are deliberately not included.

## Application identities

| App | Application ID | Version |
|---|---|---|
| Customer | `com.feastly.app` | `3.4.2` (`52`) |
| Admin | `com.feastly.admin` | `3.3.0` (`50`) |
| Restaurant | `com.feastly.restaurant` | `3.3.1` (`45`) |
| Rider | `com.feastly.rider` | `3.5.0` (`64`) |

All four apps use minimum Android SDK 23 and target SDK 36.

## Included artifacts

- Four current debug-signed local-inspection APKs.
- Four current unsigned release AAB build outputs.
- Current Phase 2 engineering handoff and feature-gap matrix.
- `SHA256SUMS` for every packaged artifact except the checksum file itself.

## Verified before packaging

- Backend typecheck/build and 221/221 tests.
- Native contract/reliability suite with 596 assertions.
- Local Firebase Realtime Database rules emulator: 9/9 scenarios.
- Four-app debug compilation and APK assembly.
- Four-app release lint with zero Error/Fatal findings.
- Four-app R8 release processing and AAB assembly.
- Android signature verification for all four debug APKs.
- Fail-closed non-production boundary: 177 Gradle tasks with synthetic local configuration.
- Active `firebase.json`, Realtime Database rules and Storage rules remained byte-identical to the start checkpoint.

See the packaged handoff for remaining engineering work, external blockers and the required isolated-device rollout sequence.
