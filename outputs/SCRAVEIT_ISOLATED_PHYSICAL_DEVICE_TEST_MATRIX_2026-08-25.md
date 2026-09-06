# Scraveit isolated-environment physical-device test matrix

Date: 2026-08-25  
Scope: Customer, Restaurant, Rider and Admin Android apps  
Purpose: next-session execution against a separately owned non-production Firebase environment

## Safety boundary

- Do not deploy to or edit `savrivo-app`.
- Do not use production accounts, payment credentials, App Check tokens or customer data.
- Keep the existing application IDs. Isolated APKs therefore replace same-package installations;
  use dedicated test devices.
- The build is not permission to deploy staged Functions or rules. That requires separate approval.
- A passing build proves configuration isolation; it does not prove the end-to-end service until the
  physical scenarios below pass against an authorized isolated backend.

## Current compatibility audit

| Check | Current result | Evidence |
|---|---|---|
| Isolated boundary static test | PASS | `node native_android/tests/nonprod_build_boundary.js` — 57 assertions |
| Full four-app static suite | PASS | `cd native_android && bash tests/run.sh` — 596 assertions |
| Gradle source compatibility | PASS | All four `assembleIsolated`, `lintIsolated` and `processIsolatedGoogleServices` tasks are registered |
| Missing external config | PASS, fail-closed | `verifyNonProdConfiguration` exits 1 and requests the four external files |
| Production defaults preserved | PASS by static gate | Existing package IDs and committed production defaults remain unchanged |
| Real isolated APK build | NOT RUN in this audit | Requires genuine external non-production Firebase files |
| Physical-device tests | NOT RUN | Requires isolated backend configuration and dedicated devices |

No APK produced with fabricated configuration is a test deliverable.

## External configuration required

Complete these before attempting the physical matrix. Record only project/app identifiers in the
evidence package; never record passwords, API keys, raw App Check tokens or payment secrets.

| ID | Required input | Acceptance condition |
|---|---|---|
| E01 | One isolated Firebase project | Project ID is not `savrivo-app` |
| E02 | Four external `google-services.json` files | Same isolated project; exact packages `com.feastly.app`, `com.feastly.restaurant`, `com.feastly.rider`, `com.feastly.admin` |
| E03 | Google sign-in configuration | Each matching Android client includes a Web OAuth client (`client_type == 3`) |
| E04 | Authorized isolated backend | Required Functions/rules/indexes are deployed only to the isolated project by an authorized operator |
| E05 | Isolated App Check setup | Register each generated device/app debug token only in the isolated project when enforcement is enabled |
| E06 | Isolated test data | Test restaurant/menu, customer, restaurant owner, admin and at least two eligible rider accounts |
| E07 | Test-only Maps configuration | Restricted to isolated/test usage; required for route/location verification |
| E08 | Devices | Four devices for normal flow; five devices for simultaneous two-rider acceptance |
| E09 | Isolated finance fixtures | Ledger-backed completed, cancelled, COD, online-paid, refund, adjustment and already-settled test cases with known paise totals |

External file layout, outside the source repository:

```text
/absolute/private/scraveit-isolated-firebase/
  customer/google-services.json
  restaurant/google-services.json
  rider/google-services.json
  admin/google-services.json
```

## Automated build gate

Run from a clean terminal with JDK 17:

```bash
cd /Users/balu/Documents/Codex/2026-08-14/i-n/native_android

export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
export ANDROID_HOME='/Users/balu/Library/Android/sdk'
export SCRAVEIT_NONPROD_FIREBASE_DIR='/absolute/private/scraveit-isolated-firebase'

node tests/nonprod_build_boundary.js
bash tests/run.sh
./gradlew verifyNonProd --console=plain
```

`verifyNonProd` must validate configuration, run isolated lint, build all four APKs, inspect native
Firebase resources and inspect packaged WebView Firebase/CSP assets. It must fail if either layer
contains `savrivo-app` or if they target different projects.

Expected APKs:

```text
app/build/outputs/apk/isolated/customer-isolated.apk
restaurant/build/outputs/apk/isolated/restaurant-isolated.apk
rider/build/outputs/apk/isolated/rider-isolated.apk
admin/build/outputs/apk/isolated/admin-isolated.apk
```

Capture build evidence:

```bash
mkdir -p /tmp/scraveit-isolated-evidence
shasum -a 256 \
  app/build/outputs/apk/isolated/customer-isolated.apk \
  restaurant/build/outputs/apk/isolated/restaurant-isolated.apk \
  rider/build/outputs/apk/isolated/rider-isolated.apk \
  admin/build/outputs/apk/isolated/admin-isolated.apk \
  > /tmp/scraveit-isolated-evidence/apk-sha256.txt
```

## Device preparation

1. Label devices `CUST`, `REST`, `ADMIN`, `RIDER-A`, and optionally `RIDER-B`.
2. Record model, Android version and API level using `adb devices -l` and `adb shell getprop`.
3. Remove or back up same-package production installations on these dedicated devices.
4. Install only the isolated APK matching each role:

```bash
adb -s CUST_SERIAL install -r app/build/outputs/apk/isolated/customer-isolated.apk
adb -s REST_SERIAL install -r restaurant/build/outputs/apk/isolated/restaurant-isolated.apk
adb -s RIDER_A_SERIAL install -r rider/build/outputs/apk/isolated/rider-isolated.apk
adb -s ADMIN_SERIAL install -r admin/build/outputs/apk/isolated/admin-isolated.apk
```

5. Launch once, grant only required permissions, and register generated App Check debug tokens in
   the isolated project if needed. Redact the token from all evidence.
6. Allow notifications. For rider background tests, separately record battery optimization,
   background-location and OEM auto-start settings; do not silently change them mid-test.

## Physical-device matrix

Use a new order ID for every scenario. Do not reuse stale orders when determining pass/fail.

| ID | Scenario and action | Pass condition | Required evidence |
|---|---|---|---|
| P01 | Cold-launch each app after install | Correct role opens without crash; no production account/data appears | Four launch screenshots; redacted crash/log extract |
| P02 | Sign in with isolated accounts, then restart each app | Session restores from isolated backend; correct role authorization is retained | Account alias, package, restart recording |
| P03 | Customer browses isolated restaurant/menu | Only isolated catalogue data appears; images and WebView screens load | Customer recording and isolated restaurant ID |
| P04 | Customer places one COD order, including rapid double tap | Exactly one order and one pricing/ledger initialization are created | Order ID, button recording, backend timeline |
| P05 | Restaurant foreground alert | New pending order appears immediately; one persistent alert/alarm starts | Timestamped recording and notification screenshot |
| P06 | Restaurant background/locked alert | Alert arrives without opening Orders; tapping notification opens correct order | Lock-screen recording and order ID |
| P07 | Restaurant accepts once, then taps again | First transition commits once; pending alarm stops; no duplicate acceptance/dispatch | Transition history and 30-second post-accept recording |
| P08 | Restaurant rejects a fresh order | Alarm stops, customer sees rejection/cancellation, and no rider offer is created | Order timeline across Customer/Restaurant/Admin |
| P09 | Rider wave dispatch | Eligible nearest wave receives offer first; later wave receives it only after configured timeout | Rider IDs, offer timestamps, dispatch event log |
| P10 | Rider background/locked offer | High-priority offer notification/alarm arrives with app backgrounded and screen locked | Screen recording, notification channel/settings snapshot |
| P11 | One rider accepts | Assignment commits once; offer moves to Active; Restaurant, Customer and Admin update | Assignment ID and four-role screenshots |
| P12 | Two riders accept nearly simultaneously | Exactly one wins; loser receives taken/expired state; losing offer and alarm disappear | Synchronized two-device recording and transaction result |
| P13 | Restaurant progresses Accepted → Preparing → Ready | Only valid control is shown at each state; no backward or duplicate transition | State history with actor/timestamps |
| P14 | Rider pickup lifecycle | Navigation targets restaurant first; arrival/pickup succeeds only for assigned rider | Rider recording, location freshness/accuracy metadata |
| P15 | Live delivery tracking | Customer/Admin receive bounded, timely rider updates; no stale location is shown as current | Timestamped map recording and redacted location events |
| P16 | Delivery OTP | Customer obtains OTP; assigned rider completes once; wrong/reused OTP is rejected | Redacted validation results—never record the OTP itself |
| P17 | COD and earnings | Delivery creates COD collected/outstanding, rider earning and restaurant payable exactly once | Ledger transaction IDs and reconciled amounts |
| P18 | Rating persistence | Customer submits one restaurant and rider rating; aggregates update; prompt does not return after restart | Review IDs, aggregate before/after, restart recording |
| P19 | Process-death recovery | Force-stop each role during its active stage, reopen, and recover authoritative order state | Before/after screenshots and package force-stop commands |
| P20 | Network interruption | Disable network during Place/Accept/Rider Accept/Pickup/Delivery separately, restore, and reconcile without duplicates | One evidence bundle per transition with final history |
| P21 | Notification deduplication | Duplicate/retried FCM or realtime refresh produces one visible semantic notification per event | Notification drawer recording and outbox/dedupe event IDs |
| P22 | Isolation check | Test writes/events exist in isolated console only; build/package evidence contains no production project reference | Isolated project ID, automated parity result; no production-console mutation |
| P23 | COD remittance | Admin records a verified partial remittance, retries the identical request, then records the remainder | One journal per operation ID; outstanding COD decreases once; exact retry is idempotent; Rider/Admin agree |
| P24 | Restaurant settlement and rider earnings | Open Restaurant, Rider and Admin finance views after P17/P23 | All views agree with immutable ledger accounts; COD cash is not rider income; pending/already-settled/history totals reconcile in paise |
| P25 | Cancellation and refunds | Run pre-accept cancellation, restaurant rejection, pre-delivery online refund and supported post-delivery recovery flow | No dispatch after terminal cancellation; no duplicate refund; finance views expose the correct pending recovery/adjustment without inventing a payout |
| P26 | Device reboot recovery | Reboot Restaurant during pending alert and Rider during assigned/delivery stages | Correct authoritative state restores; legitimate alert/tracking resumes according to policy; no duplicate transition, offer or ledger entry |
| P27 | Unauthorized finance mutation | From Customer, Restaurant and Rider sessions attempt direct ledger/projection writes and admin-only remittance/settlement calls | Every unauthorized mutation is denied; read access is limited to the caller's permitted projection; no ledger row changes |
| P28 | Finance retry and concurrency | Retry delivery completion/remittance/settlement across response timeout and submit concurrent identical/conflicting operation IDs | Identical retries return the same immutable result; conflicts fail closed; exactly-once balances and history reconcile |

Useful restart commands:

```bash
adb -s CUST_SERIAL shell am force-stop com.feastly.app
adb -s CUST_SERIAL shell monkey -p com.feastly.app -c android.intent.category.LAUNCHER 1

adb -s REST_SERIAL shell am force-stop com.feastly.restaurant
adb -s REST_SERIAL shell monkey -p com.feastly.restaurant -c android.intent.category.LAUNCHER 1

adb -s RIDER_A_SERIAL shell am force-stop com.feastly.rider
adb -s RIDER_A_SERIAL shell monkey -p com.feastly.rider -c android.intent.category.LAUNCHER 1

adb -s ADMIN_SERIAL shell am force-stop com.feastly.admin
adb -s ADMIN_SERIAL shell monkey -p com.feastly.admin -c android.intent.category.LAUNCHER 1
```

## Pass/fail record

Create one row per matrix ID:

```text
Test ID:
Build SHA-256:
Device/Android/API:
Isolated project ID:
Account alias(es):
Order/assignment/review/ledger ID(s):
Started/finished timestamps:
Expected:
Actual:
PASS / FAIL / BLOCKED_EXTERNAL:
Evidence paths:
Defect ID if failed:
```

Evidence rules:

- Use account aliases rather than email/mobile numbers.
- Redact App Check tokens, FCM tokens, OTPs, API keys, credentials and precise personal locations.
- A screenshot alone is insufficient for concurrency or exactly-once financial claims; attach
  authoritative transition/assignment/ledger IDs from the isolated backend.
- `BLOCKED_EXTERNAL` is not a pass.
- Do not claim release readiness until P01–P22 pass or each excluded scenario has an approved,
  documented reason.

## Next-session execution order

1. Complete E01–E08 without production access.
2. Run the automated build gate and archive hashes/reports.
3. Execute P01–P08 to prove ordering and restaurant behavior.
4. Execute P09–P12 with two rider devices to prove dispatch and race safety.
5. Execute P13–P18 and P23–P25 for fulfillment, finance, refunds and ratings.
6. Execute P19–P22 and P26–P28 for recovery, deduplication, authorization, finance races and isolation.
7. Fix only reproduced failures, add regression coverage, rebuild once per coherent fix batch, and
   rerun the failed scenario plus its adjacent lifecycle scenarios.
