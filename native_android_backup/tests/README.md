# Savrivo premium validation

Run the local release gate from the workspace root:

```sh
native_android/tests/run.sh
```

The validator uses only Node.js built-ins and checks:

- unauthenticated launch and rendering of every registered route;
- JavaScript syntax for all three `premium.js` files;
- absence of blocking `alert()` and `confirm()` calls;
- visible Savrivo branding and restrictive CSP declarations;
- the shared order-lifecycle graph and app-specific state coverage;
- target SDK 36, disabled backups/cleartext traffic, Savrivo icons, and native loading of `premium.html`;
- Firebase Realtime Database rules JSON parsing.

The check intentionally fails when any app still points at the legacy shell or manifest settings.
