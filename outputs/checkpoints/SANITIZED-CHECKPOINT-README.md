# Scraveit sanitized source checkpoint

This checkpoint contains the active Android, Firebase rules/migrations, and Cloud Functions source used for the 2026-08-24 production engineering pass.

It intentionally excludes:

- Android build directories and generated binaries;
- Node dependencies and generated Functions output;
- developer/debug keystores and signing material;
- App Check debug identity installers;
- Firebase Android/Web client configuration files;
- local properties, environment files, service-account files, and secrets;
- live Firebase backups, migration checkpoints, and historical duplicate source trees.

The archive is therefore a safe source checkpoint, not a directly buildable distribution. Restore the four approved `google-services.json` files, the four local Web Firebase configuration files, the private production signing setup, and the restricted Maps key from the controlled configuration store before building.

Production data is not included. No live Firebase data was deleted or copied into this checkpoint.
