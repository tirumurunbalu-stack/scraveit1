# Scraveit staging physical E2E runbook

Date: 2026-08-25  
Scope: Customer, Restaurant, Rider and Admin Android apps  
Environment: current Firebase project `savrivo-app` treated as **STAGING / SANDBOX** through **September 1, 2026**

## Safety boundary

- Use the current committed Firebase configuration only for **staging** orders, alarms, dispatch, COD and finance validation.
- Do not use real customers, real financial data or irreversible production accounts.
- Use dedicated Android devices because the package identities remain unchanged:
  - Customer: `com.feastly.app`
  - Restaurant: `com.feastly.restaurant`
  - Rider: `com.feastly.rider`
  - Admin: `com.feastly.admin`
- Do not claim production readiness from this runbook alone. It is for staging/device validation.
- A fresh Firebase project will still be required for real production after September 1, 2026.

## What is already verified before device testing

| Area | Status | Evidence |
|---|---|---|
| Staging Firebase config consistency | PASS | `node native_android/tools/verify_staging_firebase.mjs` |
| Static/native app validation | PASS | `native_android/tests/run.sh` |
| Standard four-app debug packaging | PASS | `native_android/build_savrivo.sh --skip-tests` |
| Staging sandbox APK packaging | PASS | `native_android/build_staging_sandbox.sh --skip-tests` |
| Production Firebase mutation in this phase | NO | staging-only build/install tooling added; no deploy performed |

## Required hardware

Minimum for normal flow:

- 1 Customer device
- 1 Restaurant device
- 1 Rider device
- 1 Admin device

Required for the rider-race test:

- a **second** Rider device

Recommended labels:

- `CUST`
- `REST`
- `RIDER-A`
- `RIDER-B`
- `ADMIN`

## Two-phone execution layout for the current run

For the first physical staging pass with the currently attached devices:

- **Phone 1** = Customer + Restaurant + Admin
- **Phone 2** = Rider

Use these environment variables:

```sh
export SCRAVEIT_PHONE1_SERIAL='RZ8T5052W3R'
export SCRAVEIT_PHONE2_SERIAL='368a3272'
```

This is valid for the full single-rider happy path and the alarm/notification/restart/COD flows.
It is **not** sufficient for the true simultaneous rider-race scenario. That specific test still
requires a **third phone** so Rider A and Rider B can act independently.

## Build and preflight

From the repository root:

```sh
native_android/tests/run.sh
native_android/build_staging_sandbox.sh
```

Expected APK directory:

```text
native_android/build/savrivo_staging_sandbox/
```

Set connected device serials:

```sh
export SCRAVEIT_PHONE1_SERIAL='<adb-serial>'   # Customer + Restaurant + Admin
export SCRAVEIT_PHONE2_SERIAL='<adb-serial>'   # Rider

# or use the larger dedicated-device layout below
export SCRAVEIT_CUSTOMER_SERIAL='<adb-serial>'
export SCRAVEIT_RESTAURANT_SERIAL='<adb-serial>'
export SCRAVEIT_RIDER_A_SERIAL='<adb-serial>'
export SCRAVEIT_RIDER_B_SERIAL='<adb-serial>'
export SCRAVEIT_ADMIN_SERIAL='<adb-serial>'   # optional but strongly recommended
```

Run the preflight:

```sh
native_android/tools/staging_device_preflight.sh \
  native_android/build/savrivo_staging_sandbox
```

Then install the builds:

```sh
native_android/tools/install_staging_apks.sh \
  native_android/build/savrivo_staging_sandbox
```

## Shared evidence rules

- Use fresh synthetic test accounts only.
- Use a fresh order for every scenario.
- Record order IDs, assignment IDs and ledger IDs.
- Redact OTPs, tokens, API keys, exact personal addresses and phone numbers.
- For finance scenarios, screenshots alone are not enough. Capture the matching ledger IDs and totals.

## Physical test matrix

### Test A — Standard order lifecycle

Goal:

Customer places order  
→ restaurant gets persistent alert  
→ restaurant accepts  
→ rider dispatch begins  
→ nearest rider gets offer  
→ one rider accepts  
→ pickup/handover  
→ delivery  
→ all four apps agree on final state

Pass conditions:

- exactly one order is created
- restaurant alarm starts once
- rider assignment occurs once
- losing riders do not retain stale offers
- order reaches delivered state in Customer, Restaurant, Rider and Admin

Evidence:

- order ID
- restaurant acceptance timestamp
- rider assignment ID
- completion timestamp
- one screenshot/recording per role

### Test B — Concurrent rider acceptance

Use Rider A and Rider B on separate devices.

Pass conditions:

- both riders can see the eligible offer when the dispatch wave reaches them
- simultaneous Accept attempts produce exactly one winner
- loser gets authoritative taken/expired result
- losing alarm stops immediately
- no duplicate assignment or duplicate earnings/ledger event is created

Release blocker if failed: **YES**

### Test C — Restaurant alarms

Verify:

- new pending order starts the alarm
- background and locked-device behavior works
- duplicate notification delivery does not stack multiple alarms
- Accept stops the pending alarm
- Reject stops the pending alarm
- app restart does not resurrect a stale accepted order alarm

### Test D — Rider notifications

Verify on Rider A and Rider B as applicable:

- foreground notification
- background notification
- locked-screen notification
- killed-app notification
- notification tap opens the right active flow
- losing rider offer disappears if another rider wins

### Test E — GPS arrival

Physically move through both route phases:

- rider to restaurant
- rider to customer

Verify:

- arrival is not triggered from one noisy fix
- restart/background behavior resumes correctly
- restaurant arrival and customer arrival both require stable fresh location

### Test F — COD lifecycle

Run a full COD delivery and verify:

- collected COD is stored as rider/platform liability, not rider income
- rider earnings remain correct
- Admin COD exposure updates exactly once
- remittance reduces outstanding COD exactly once
- restaurant settlement still reconciles correctly

### Test G — Network loss and restart resilience

Intentionally interrupt the devices during:

- Place Order
- Restaurant Accept
- Rider Accept
- Pickup
- Delivery

For each interruption:

- disable network, then restore it
- force-stop/reopen the relevant app
- verify authoritative backend state wins
- verify there are no duplicate order, assignment or ledger events

### Test H — Cancellation and refund edge cases

Verify supported paths:

- cancel before restaurant acceptance
- restaurant rejection
- cancellation while rider is being searched
- refund/accounting consistency
- stale actions rejected after terminal state

## Useful commands during testing

Restart apps:

```sh
adb -s "$SCRAVEIT_CUSTOMER_SERIAL" shell am force-stop com.feastly.app
adb -s "$SCRAVEIT_CUSTOMER_SERIAL" shell monkey -p com.feastly.app -c android.intent.category.LAUNCHER 1

adb -s "$SCRAVEIT_RESTAURANT_SERIAL" shell am force-stop com.feastly.restaurant
adb -s "$SCRAVEIT_RESTAURANT_SERIAL" shell monkey -p com.feastly.restaurant -c android.intent.category.LAUNCHER 1

adb -s "$SCRAVEIT_RIDER_A_SERIAL" shell am force-stop com.feastly.rider
adb -s "$SCRAVEIT_RIDER_A_SERIAL" shell monkey -p com.feastly.rider -c android.intent.category.LAUNCHER 1

adb -s "$SCRAVEIT_ADMIN_SERIAL" shell am force-stop com.feastly.admin
adb -s "$SCRAVEIT_ADMIN_SERIAL" shell monkey -p com.feastly.admin -c android.intent.category.LAUNCHER 1
```

Basic device inventory:

```sh
adb devices -l
adb -s "$SCRAVEIT_CUSTOMER_SERIAL" shell getprop ro.product.model
adb -s "$SCRAVEIT_CUSTOMER_SERIAL" shell getprop ro.build.version.release
```

## Pass/fail record template

```text
Test:
Order ID:
Assignment ID:
Ledger ID(s):
Devices used:
Started:
Finished:
Expected:
Actual:
PASS / FAIL / BLOCKED:
Notes:
```

## Execution order

1. Run preflight and install staging APKs.
2. Execute Test A first to prove the happy path.
3. Execute Test C and Test D to confirm alarm/notification behavior.
4. Execute Test B with two riders.
5. Execute Test E for physical movement/arrival.
6. Execute Test F for COD and remittance.
7. Execute Test G for restart/network resilience.
8. Execute Test H for cancellations/refunds.

## Production migration reminder

This runbook uses the **current Firebase project only as staging**.  
Do not hard-code this project identity into business logic, and do not treat staging data as real production data.  
After September 1, 2026, a fresh Firebase project still needs to be created and wired for production rollout.
