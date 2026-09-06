# Savrivo Firebase deployment files

- `feastly-realtime-database-rules.json` — the currently active-compatible Realtime Database rules. `firebase.json` deliberately continues to point here.
- `feastly-realtime-database-rules.production-functions-stage1.json` — a deploy-later stage-1 policy for the callable Functions rollout. It is a complete rules file, but it is **not** the configured deployment target.
- `firebase.production-functions-stage1.json` — an explicit database-only Firebase CLI configuration for the eventual reviewed stage-1 deployment.
- `feastly-realtime-database-rules.admin-claims-stage2.json` — a deploy-later copy of stage 1 with only literal UID/email administrator shortcuts removed. It accepts owner/operations-admin authority exclusively from the `savrivoRole` custom claim.
- `firebase.admin-claims-stage2.json` — an isolated database-only configuration for the custom-claims migration gate. The default Firebase configuration does not reference it.
- `storage.rules` — Firebase Storage rules for restaurant media and private rider KYC.
- `tests/validate-functions-rules.mjs` — proves that stage 1 locks every Functions-exclusive path, changes only the reviewed workload authority, preserves every other existing rule subtree, and cannot be deployed by the default Firebase command accidentally.

Validate the staged policy from the repository root:

```bash
node firebase/tests/validate-functions-rules.mjs
jq empty firebase/feastly-realtime-database-rules.production-functions-stage1.json
```

## Two-stage Functions rules migration

Stage 1 adds explicit server-only boundaries and moves the derived restaurant workload to the backend. It denies all client writes to:

- `/feastly/orderIdempotency`
- `/feastly/private`
- `/feastly/backendEvents`
- `/feastly/paymentAttempts`
- `/feastly/paymentAttemptsByMerchantOrder`
- `/feastly/paymentEvents`
- `/feastly/riderAvailabilityByCity`
- `/feastly/deviceTokens`
- `/feastly/riderWallets`
- `/feastly/pricingSignals`
- `/feastly/restaurantLoad/{restaurantId}`

Delivery OTPs, push tokens and backend leases deny client reads as well. Payment records, pricing signals and the rider availability index are readable only by owner/operations-admin accounts. A rider can read only `/feastly/riderWallets/{theirUid}`; every wallet write remains server-only.

The updated Restaurant app no longer publishes `/restaurantLoad`; Functions derive it from canonical order transitions so a staff device cannot manipulate demand or surge inputs. Stage 1 otherwise preserves the current direct client permissions on canonical orders, restaurant-order mirrors, dispatch queues, rider jobs, rider presence, tracking and audit. Locking those paths now would break installed app versions before their callable migration is adopted.

After backups, emulator/staging proof and explicit approval, the isolated deployment command is:

```bash
firebase deploy --only database \
  --config firebase/firebase.production-functions-stage1.json \
  --project savrivo-app
```

This command is documented for the approved release window only. It has not been run here.

Stage 2 is a separate post-adoption change. Only after Customer uses `createCodOrder`, Restaurant/Admin/Rider use `updateOrderStatus`, Rider uses `claimRiderOrder`, and every app uses the push-token callables should the production policy:

1. deny customer creation and all client status/rider-assignment writes under `/feastly/orders`;
2. make `/feastly/restaurantOrders` a server-written mirror;
3. make `/feastly/dispatchQueue` and `/feastly/riderJobs` server-write-only;
4. make `/feastly/audit` server-write-only;
5. narrow `/feastly/riderPresence/{riderId}` to rider-owned heartbeat fields, excluding backend-owned `activeOrderId`;
6. retain rider-owned live GPS writes under `/feastly/tracking/{orderId}` only while that rider is assigned to the active order.

Do not perform stage 2 based on a date. Gate it on installed-version telemetry and a verified rollback path.

## Administrator custom-claims gate

The claims-gated rules are deliberately separate from the broader client-write migration described above. They remove only the legacy literal UID/email administrator shortcuts; every other stage-1 permission remains byte-semantically unchanged.

First validate the artifact:

```bash
node firebase/tests/validate-admin-claims-stage2.mjs
```

Then use Application Default Credentials from a controlled operator machine to preview an explicit UID-only allowlist. Email addresses are rejected and the command is dry-run unless `--apply` is supplied:

```bash
SAVRIVO_EXPECTED_PROJECT_ID='<project-id>' \
SAVRIVO_OWNER_UIDS='<firebase-uid>[,<firebase-uid>...]' \
SAVRIVO_OPS_ADMIN_UIDS='<firebase-uid>[,<firebase-uid>...]' \
node functions/scripts/migrate-admin-claims.mjs
```

The preflight also enumerates existing custom claims and blocks if any current `owner` or `ops_admin` principal is absent from the explicit UID allowlist. It never grants authority from an email address and logs only short one-way UID fingerprints. Resolve every missing or unexpected principal before applying; the script does not revoke accounts automatically.

After reviewing the dry run, apply requires both the flag and a second exact project confirmation:

```bash
SAVRIVO_EXPECTED_PROJECT_ID='<project-id>' \
SAVRIVO_CONFIRM_PROJECT_ID='<project-id>' \
SAVRIVO_OWNER_UIDS='<firebase-uid>[,<firebase-uid>...]' \
SAVRIVO_OPS_ADMIN_UIDS='<firebase-uid>[,<firebase-uid>...]' \
node functions/scripts/migrate-admin-claims.mjs --apply
```

Do not deploy the staged rules until every allowlisted administrator has been verified with a freshly issued ID token in a staging/emulator test. Prove that each intended owner/operations administrator can perform the required Admin reads and writes, that an ordinary authenticated user is denied, and that an account with a matching email but no claim is denied. Export the current rules immediately before the release window. Keep that export as the rollback target. Only after the verification gate passes, the isolated deployment command is:

```bash
firebase deploy --only database \
  --config firebase/firebase.admin-claims-stage2.json \
  --project '<project-id>'
```

This command is documentation for an approved release window. It has not been run here.

If the claims-gated rollout causes an access regression, immediately restore the preceding Functions stage-1 rules without changing Functions or Android applications:

```bash
firebase deploy --only database \
  --config firebase/firebase.production-functions-stage1.json \
  --project '<project-id>'
```

After recovery, diagnose token refresh and claim assignment before attempting the claims-gated rules again. Do not add a new UID/email shortcut as a rollback mechanism.

These files are repository configuration only. Android builds do not deploy them. The production Firebase project is `savrivo-app`; always export live data and rules, test in an emulator/non-production project, and use an explicit `--project savrivo-app` when an approved deployment is eventually performed.

## Private operational projections (stage 5, staged only)

The operational projection rollout is intentionally isolated from the active deployment:

- `feastly-realtime-database-rules.operational-projections-stage5.json` is generated deterministically from server-authority stage 4. Its only additional rules changes are the bounded-query indexes at `/feastly/private/operations/orders`, `/feastly/private/financialLedger/journals`, and `/feastly/riderWallets` (`codOutstanding`). Existing read/write authorization is unchanged.
- `firebase.operational-projections-stage5.json` is a database-only opt-in deployment configuration. The default root `firebase.json` still targets the active-compatible rules.
- `tests/validate-operational-projections-stage5.mjs` proves the exact index-only diff, retained private/server-only boundary, unchanged rider-wallet authorization, retained earlier indexes, unchanged stage 4, and unchanged default deployment target.
- `functions/scripts/backfill-operational-projections.mjs` is the bounded, resumable migration utility for existing canonical orders and rider jobs. It defaults to dry-run, logs aggregate counts only, and cannot write unless `--apply` and an exact project confirmation are both supplied.

First regenerate and validate the isolated artifact:

```bash
node firebase/tools/build-operational-projections-stage5.mjs
node firebase/tests/validate-operational-projections-stage5.mjs
npm --prefix functions run build
npm --prefix functions test
```

Do **not** deploy stage 5 independently over the current rules. It inherits every prior stage, including the custom-claims and server-authority changes. The approved release sequence is:

1. Export live data and the currently deployed rules; retain both as rollback evidence.
2. Complete every stage-2 custom-claims and stage-4 installed-client/callable adoption gate in an emulator or non-production project.
3. Deploy the reviewed Functions build containing the operational-order and rider-workload reconciliation triggers.
4. Run the backfill in dry-run mode with Application Default Credentials that have read access. The exact database root URL is required and is fingerprinted—not printed—in the local checkpoint:

   ```bash
   SAVRIVO_EXPECTED_PROJECT_ID='<project-id>' \
   SAVRIVO_DATABASE_URL='https://<database-instance>.firebaseio.com' \
   node functions/scripts/backfill-operational-projections.mjs \
     --page-size=100 --max-records=500
   ```

5. Review the aggregate `ordersVisited`, `riderWorkloadsVisited`, `writesPlanned`, and `invalidRecords` counts. Resolve invalid canonical records before applying. No database or checkpoint writes occur in dry-run mode.
6. Apply only in the approved migration window. The confirmation must exactly equal the expected project. Each run is capped; rerun the same command to resume from the mode-0600 local checkpoint:

   ```bash
   SAVRIVO_EXPECTED_PROJECT_ID='<project-id>' \
   SAVRIVO_CONFIRM_PROJECT_ID='<project-id>' \
   SAVRIVO_DATABASE_URL='https://<database-instance>.firebaseio.com' \
   node functions/scripts/backfill-operational-projections.mjs --apply \
     --page-size=100 --max-records=500
   ```

7. Verify active/recent order counts and rider workload counts against bounded canonical samples. Keep the checkpoint until verification completes. Re-running is safe: order projections reject stale source revisions and rider-workload writes never replace a newer live-trigger projection.
8. Only after the rules, Functions, claims, backfill, and rollback gates pass together, deploy the isolated indexed rules with an explicit project:

   ```bash
   firebase deploy --only database \
     --config firebase/firebase.operational-projections-stage5.json \
     --project '<project-id>'
   ```

No stage-5 rules, Functions, or production data were deployed by adding these artifacts. If rollout verification fails, stop the migration and restore the pre-window rules export; do not weaken `/feastly/private` permissions or delete canonical orders/rider jobs.

### Local stage-5 authorization integration tests

The narrow Realtime Database rules suite under `firebase/emulator-tests` evaluates the exact staged stage-5 rules against an isolated Firebase Database Emulator. It uses the reserved `demo-scraveit-rules-stage5` project ID, seeds only the local emulator with synthetic records, and fails closed if `FIREBASE_DATABASE_EMULATOR_HOST` is absent. It does not use production credentials, read or write live data, deploy rules, or change the default Firebase deployment target.

Install the exact locked test dependencies and run the suite from the repository root:

```bash
npm --prefix firebase/emulator-tests ci --ignore-scripts
npm --prefix firebase/emulator-tests run test:stage5
```

The suite verifies the highest-risk P0 boundaries: customer order-transition denial, restaurant tenant isolation, server-owned rider claiming/completion, private finance/dispatch/control denial, and the intended scoped customer, restaurant, rider, and owner reads or narrow writes. Permission-denied warnings are expected for negative assertions.

The runner is pinned to Firebase CLI 14.26 because the current developer machine has Java 11. Firebase CLI 15 requires Java 21. Upgrade the local JDK to Java 21 before updating this test-only runner to CLI 15; do not compensate by weakening rules or changing production configuration.
