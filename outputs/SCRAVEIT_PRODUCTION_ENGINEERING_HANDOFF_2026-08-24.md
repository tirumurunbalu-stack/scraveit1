# Scraveit production engineering handoff

Date: 2026-08-24  
Scope: Customer, Restaurant, Rider, Admin, Firebase Realtime Database, Firebase Storage, Firebase Cloud Messaging, Cloud Functions, Android release pipeline.

## Executive status

This pass hardened the shared platform architecture and preserved the existing package identities, Firebase project, database namespace, and working app workflows. It did not deploy Cloud Functions, staged rules, custom claims, or production data migrations. No production data was deleted.

The source is materially safer and more production-oriented, but Google Play publication remains blocked by external signing, Maps, Play Integrity registration, legal/store, and provider-credential gates. PhonePe remains fail-closed until real merchant credentials and callback verification are supplied.

## Discovered platform

- Android architecture: four Java Android applications hosting bundled HTML/CSS/JavaScript experiences through hardened native WebView bridges.
- Customer: `com.feastly.app`, version 3.4.2 (52).
- Admin: `com.feastly.admin`, version 3.3.0 (50).
- Restaurant: `com.feastly.restaurant`, version 3.3.1 (45).
- Rider: `com.feastly.rider`, version 3.5.0 (64).
- Firebase project: `savrivo-app`.
- Compatibility namespace: `/feastly` in Realtime Database.
- Callable Functions region: `asia-south1`; database triggers remain in their existing trigger region.
- Android minimum SDK 23; target and compile SDK 36.
- The workspace is not a Git repository, so a sanitized source archive was created as the checkpoint instead of pretending a Git branch exists.

## High-impact engineering completed

### Authoritative order lifecycle

- Added an explicit, server-validated lifecycle covering fulfillment, dispatch, payment, and terminal axes.
- Invalid and backward transitions are rejected.
- Actor permissions and expected revisions are checked on server callables.
- Transitions carry server timestamps, actor metadata, previous/new state, and audit information.
- Duplicate acceptance, retry, and stale-client operations are idempotent or return deterministic conflict states.
- Existing legacy status fields remain compatible while canonical lifecycle fields become authoritative.

### Dispatch and rider claims

- Added configurable progressive/wave dispatch instead of uncontrolled broadcast assignment.
- Eligibility checks online/available state, account approval, service city, current workload, location validity, and location freshness.
- Rider ranking uses pickup suitability, distance, freshness, workload, and fairness inputs.
- Atomic rider claim guarantees first valid acceptance wins and invalidates competing offers.
- Added recovery for partial rider-claim failures and deterministic dispatch metrics.
- Important dispatch values are centralized in validated platform configuration rather than scattered constants.

### Reliable synchronization and notifications

- Added a durable notification outbox with order/event idempotency keys.
- Supports multiple devices, partial-delivery retry, token cleanup, exponential retry, and dead-letter handling.
- Realtime database state remains authoritative; notifications are never treated as authoritative order state.
- New-order, status, assignment, cancellation, delivery, and operational notification messages are separated to prevent duplicate semantics.
- Operational order and rider-workload projections are bounded and server-owned for fast Admin/Restaurant queries.

### Pricing, payments, ledger, and COD

- Added server-authoritative order pricing snapshots and validation boundaries.
- Added canonical payment-state transitions, deterministic payment intents/events, verified callback architecture, refund states, and legacy-compatible projections.
- PhonePe integration remains intentionally fail-closed until credentials and approved callback configuration exist.
- Added immutable balanced ledger concepts for customer receipts, restaurant payable, platform commission, rider earnings, tips, refunds, and COD.
- Added owner/operations-admin-only, App Check-enforced COD remittance recording.
- COD remittance uses integer paise, atomic wallet reservations, concurrency protection, deterministic ledger IDs, immutable conflicts, retry recovery, and audit logs.
- Default missing-policy COD exposure is ₹5,000 per rider. A live explicitly stored `0` remains unlimited until operations deliberately updates it to `500000` paise.

### Ratings and Customer startup

- Removed the false review prompt shown before authoritative account-scoped review hydration.
- Prevented review state from crossing between accounts or being replaced by stale responses.
- Preserved submitted restaurant/rider ratings and comments and made them visible in order feedback.
- Removed unverified post-delivery money controls; backend rejects/sanitizes legacy or malicious review-money values to zero.
- Verified restaurant aggregate ratings are cached/rendered only with real counts; no production rating is fabricated.

### Security and operational control

- Closed cross-restaurant legacy staff access so a staff member cannot operate unrelated restaurants.
- Added owner/operations-admin custom-claim control with audit and idempotency.
- Staged rules progressively lock backend-owned orders, mirrors, dispatch, rider jobs, wallets, payments, private projections, and audit records.
- The active compatibility rules were not replaced because doing so before minimum-client adoption would break installed clients.
- Added exact rule-difference validators and explicit rollback/adoption gates.
- Added a dry-run-first, bounded, resumable, exact-project-checked operational-projection backfill.
- Release R8 preserves the Play Integrity App Check factory; debug providers remain debug-only.
- All four apps disable Android cloud/device backup for authentication, WebView, database, preferences, and sensitive files.

### Performance foundations

- Customer restaurant discovery is city-scoped and bounded instead of loading the entire catalogue.
- Added indexed operational projections for active/recent order views.
- Added bounded reconciliation and workload projections rather than unbounded client scans.
- Existing lifecycle-aware listeners, image caching/lazy loading, home cache, and offline recovery remain intact and covered by regression contracts.

## Verification evidence

- Cloud Functions: typecheck passed, build passed, 30 test files / 178 tests passed.
- Android contract suite: 577 assertions passed across all four apps.
- Full Android production gate: 205 Gradle tasks executed; build successful.
- Firebase validators: Functions stage 1, admin claims stage 2, query indexes stage 3, server authority stage 4, operational projections stage 5, rollout gates, and server-authority audit all passed.
- Release lint: Customer 0 errors/3 warnings; Admin 0/22; Restaurant 0/17; Rider 0/22.
- Release bundles contain production Play Integrity and exclude debug App Check dependencies/identities.
- Firebase package/project linkage is consistent for all four apps.

These are automated build and contract results. Physical-device, killed-app notification, low-memory, background-location, simultaneous multi-device, payment-provider, and Play-installed App Check testing still require the controlled staging/internal track.

## Staged rollout order — do not skip steps

1. Export live RTDB data and current rules; verify the export and rollback command.
2. Configure final Play App Signing SHA-1/SHA-256, production App Check for all four apps, Google OAuth, restricted Maps key, FCM/IAM, and approved runtime secrets.
3. Provision `savrivoRole=owner|ops_admin` by UID, force token refresh, and prove ordinary users are denied.
4. Run Functions and database emulators plus a non-production end-to-end canary.
5. Deploy the reviewed Functions build first and observe callable/outbox/dispatch/ledger errors without changing client authority.
6. Release compatible app versions through Play internal testing and confirm installed-version adoption.
7. Deploy staged database rules in sequence only after each gate passes: stage 1 → stage 2 claims → stage 3 indexes → stage 4 server authority.
8. Build/deploy operational projection Functions, run the stage-5 backfill dry-run, review aggregates, apply in bounded pages, verify, then deploy stage-5 index rules.
9. Enable finite live COD exposure by deliberately setting `finance.codOutstandingLimitPaise=500000` if the persisted value is currently explicit `0`.
10. Expand rollout only after rollback rehearsal, monitoring, race tests, and physical-device workflows pass.

## External blockers and required business inputs

- Protected Google Play upload key and Play App Signing configuration.
- Restricted Android Maps API key for `com.feastly.app` and final Play signing fingerprint.
- Final Play Integrity/App Check registrations for all four apps.
- PhonePe merchant credentials, callback allowlisting/signature contract, settlement account, and production certification.
- Approved weather and number-masking providers if those paid features are enabled.
- Privacy Policy, Terms, refund/cancellation policy, account-deletion URL, rider/restaurant agreements, support contact, and Data Safety declarations.
- Licensed restaurant/menu media, verified business/tax/FSSAI information, operational hours, and service-area policy.

## Important artifacts

- Fresh unsigned engineering candidate: `outputs/scraveit-engineering-candidate-2026-08-24/`.
- Sanitized source checkpoint: `outputs/checkpoints/scraveit-source-sanitized-2026-08-24.tar.gz`.
- Checkpoint SHA-256: `3e7e90e52c71426e70c68223ba3b6a30b18016ab1b0d85b78d534f7f040f8c70`.
- Stage-4 rollout gates: `firebase/server-authority-stage4-rollout-gates.json`.
- Stage-5 migration procedure: `firebase/README.md`.

The previous checkpoint was moved to Trash because it contained debug-only App Check attestation configuration. It remains recoverable there, but it must not be shared or treated as sanitized.

## Local verification commands

```bash
npm --prefix functions run typecheck
npm --prefix functions test
npm --prefix functions run build
bash native_android/tests/run.sh
node firebase/tests/validate-functions-rules.mjs
node firebase/tests/validate-admin-claims-stage2.mjs
node firebase/tests/validate-query-indexes-stage3.mjs
node firebase/tests/validate-server-authority-stage4.mjs
node firebase/tests/validate-operational-projections-stage5.mjs
node firebase/tests/validate-server-authority-rollout-gates.mjs
node firebase/tests/audit-server-authority-contract.mjs firebase/feastly-realtime-database-rules.server-authority-stage4.json
```

From `native_android/`, with Android Studio's JDK and Android SDK configured:

```bash
./gradlew --no-daemon --stacktrace --rerun-tasks verifyProduction
```

Firebase deploy commands are intentionally documented in `firebase/README.md` but were not run in this pass.
