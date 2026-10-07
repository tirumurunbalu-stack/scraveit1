# Savrivo premium validation

Run the local release gate from the workspace root:

```sh
native_android/tests/run.sh
```

The validator uses only Node.js built-ins and checks:

- unauthenticated launch and rendering of every registered route;
- JavaScript syntax for all four `premium.js` files;
- absence of blocking `alert()` and `confirm()` calls;
- visible Savrivo branding and restrictive CSP declarations;
- the shared order-lifecycle graph and app-specific state coverage;
- pinned Gradle/Android tooling and an external-only release-signing boundary;
- Gradle-owned compile SDK 36, min SDK 24, target SDK 36, Build Tools 36.0.0, and a version code read from each module's `build.gradle` that never drops below one already released;
- Credential Manager Google ID-token integration and a `savrivo-app` Web OAuth client;
- disabled backups/cleartext traffic, Savrivo icons, and native loading of `premium.html`;
- the deployed Firebase config (`firebase/tests/validate-deploy-config.mjs`): every rules/index file `firebase.json` references, the live-tracking Realtime Database target, and Firestore indexes.

The vm-sandboxed harnesses load each app's real `premium.js` with an in-memory
stand-in for the Firebase compat SDK (`support/firebase_compat_stub.js`: auth,
and a Firestore with real range/limit/cursor semantics, read/write logs and an
offline switch). The catalogue tests run the shipped Firestore query builders
against it.

The check intentionally fails when any app still points at the legacy shell or manifest settings.
