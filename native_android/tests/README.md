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
- Gradle-owned compile SDK 36, min SDK 23, target SDK 36, Build Tools 36.0.0 and version code 31;
- Credential Manager Google ID-token integration and a `savrivo-app` Web OAuth client;
- disabled backups/cleartext traffic, Savrivo icons, and native loading of `premium.html`;
- Firebase Realtime Database rules JSON parsing.

The check intentionally fails when any app still points at the legacy shell or manifest settings.
