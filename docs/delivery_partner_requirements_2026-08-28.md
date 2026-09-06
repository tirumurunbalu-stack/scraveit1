# Delivery Partner App requirements

Date consolidated: 2026-08-28  
Scope: Rider / Delivery Partner app only  
Source: user instructions already given in this project thread

## 1. Core product goal

Build the Delivery Partner app so rider earnings, incentives, login-slot attendance, late-night pay, referral rewards, payout details, and weekly history behave correctly, are backend-authoritative, and are shown clearly in the Rider app.

The app must use the existing verified order, dispatch, finance, COD, payout, and Firebase architecture. Do not redesign unrelated systems.

## 2. Incentive offers and eligibility

### 2.1 Extra earning offers screen

The Rider app must include a production-grade `Extra Earning Offers` experience with:

- horizontally scrollable date selector / week strip
- selected day state
- today state
- special-offer day markers
- completed-incentive day markers
- active / upcoming / completed / missed offers
- real-time progress without requiring app reopen

### 2.2 Grouped login-condition logic

An incentive offer can contain multiple independent condition groups.

Each group contains one or more slot options.

The rider must satisfy the minimum required number of slots inside each group independently.

Logic:

`Group 1: option A OR option B OR option C`
and
`Group 2: option D OR option E`
and
`Other conditions`
and
`Trips / payout requirements`

This must never collapse into “one slot anywhere in the day”.

### 2.3 Daily default session rule

Current default rider rule:

- rider must complete at least `2 valid sessions / shifts per day`

This should stay configurable later, but `2` is the required current default.

### 2.4 Daily conditions

The same daily conditions apply no matter which allowed slots the rider uses:

- complete at least `2 valid sessions / shifts`
- do not reject more than `1` order
- do not cancel more than `1` booked shift
- do not leave more than `1` shift incomplete

Eligibility examples:

- 0 or 1 rejection = still eligible
- 2+ rejections = fail
- 0 or 1 cancelled shift = still eligible
- 2+ cancelled shifts = fail
- 0 or 1 incomplete shift = still eligible
- 2+ incomplete shifts = fail

### 2.5 Daily reset behavior

Eligibility resets each service day:

- previous day is finalized
- previous day incentive result is locked in history
- session count resets
- reject count resets
- cancelled-shift count resets
- incomplete-shift count resets
- new day progress starts from zero

Yesterday’s progress must not carry into today.

## 3. Shift / slot completion rules

### 3.1 Full-slot attendance requirement

A login session / shift is complete only when the rider stays online for the required duration of the configured slot timeline.

Being online briefly inside a slot must not count.

Example:

- `1 AM online alone` must not count as completing a valid login slot

### 3.2 Offline tolerance

Allow a cumulative offline tolerance of up to `10 minutes per slot` for brief interruptions such as:

- temporary network loss
- accidental app close
- restart
- brief reconnection delay

Rules:

- do not reset accumulated progress after a tolerated interruption
- if cumulative offline time exceeds tolerance, slot fails unless Admin explicitly configures otherwise

### 3.3 Attendance authority

Attendance and qualifying time must be server-authoritative using backend timestamps.

Do not trust rider device time.

### 3.4 Required edge cases

Support correctly:

- slot crossing midnight
- rider reconnect
- app killed then reopened
- several brief offline gaps
- offline total above tolerance
- manual offline
- device restart
- late start
- early leave
- booking cancelled
- booked shift never started
- duplicate presence updates
- timezone mismatch

## 4. Slot catalog and city availability

### 4.1 Required slots

Support configurable slot booking / attendance for:

- `6:00 AM – 8:00 AM`
- existing current slots
- `11:00 PM – 2:00 AM`
- `2:00 AM – 6:00 AM`

### 4.2 Midnight ownership

Slots such as `11 PM – 2 AM` belong to one consistent service-day session instance and must not split incorrectly just because midnight passed.

### 4.3 City-based slot visibility

Admin must control slot availability per city / town.

Example city policy:

- Naidupeta can disable `6–8 AM`, `11 PM–2 AM`, `2 AM–6 AM`
- Hyderabad can keep all enabled

Rider app behavior:

- rider only sees or can book slots available for their city
- disabled slots must not be bypassable from client side

## 5. Late-night / early-morning extra pay

### 5.1 Required extra-pay behavior

Support backend-controlled extra pay for eligible completed orders inside slot windows:

- `11:00 PM – 2:00 AM` → Admin-configured late-night extra fee
- `2:00 AM – 6:00 AM` → default `₹10 extra per eligible completed order`

Important:

- `₹10` is only a default, not a permanent hardcoded value
- Admin must be able to change amount, active state, slot, city, and schedule
- Rider app must show the active bonus clearly before and during the slot

### 5.2 Ledger authority

All extra pay must be:

- calculated server-side
- credited exactly once
- reflected in payable earnings
- visible in Rider history

## 6. Earnings and payable visibility

### 6.1 Rider earnings screen

The Rider earnings area must clearly show:

- payable amount
- completed trips
- COD outstanding
- recent signed ledger rows
- current finance snapshot
- weekly earnings history
- day selection
- fast loading when switching day or week

### 6.2 Incentive visibility

For each active incentive / offer, Rider app must show:

- potential earning
- current unlocked earning
- trips completed
- next milestone
- group completion status
- selected day slot progress
- individual slot progress bars
- other condition status
- current payout / credited amount

### 6.3 Statuses

Support rider-visible statuses including:

- UPCOMING
- ACTIVE
- IN_PROGRESS
- QUALIFIED
- COMPLETED
- FAILED
- EXPIRED
- CANCELLED
- PAID

### 6.4 Weekly history retention

Keep durable weekly history with at least:

- week/date range
- daily earnings
- trip earnings
- daily incentive earned
- surge / late-night fees
- other incentive earnings
- total payable
- payout status

History must remain after the next day resets.

## 7. Payout / bank details in rider app

The Rider app must include a separate payout destination / bank details section with:

- UPI details
- bank details
- beneficiary details
- preferred payout method
- clear saved / incomplete state
- separate from pricing or admin-only settings

The Rider app must read backend policy and never invent payout state.

## 8. Referral program in rider app

Current required referral behavior:

- each rider has a unique `6 digit` referral code
- inviter can share code or link
- inviter earns `₹500`
- reward unlocks only after referred rider completes `25 successful orders`

Rider app must show:

- rider’s own code
- referral status
- referred rider count
- earned referral rewards
- program active / inactive state

## 9. Performance and UX requirements

### 9.1 Must feel stable

The Rider app should not feel broken or half-rendered.

Avoid:

- default WebView-looking controls
- clipped chips
- slow day/week switching
- blank sections when cached authoritative data exists
- infinite loading where a clear state can be shown

### 9.2 Visual requirements

Use clean modern cards matching the app’s own design system.

Keep:

- date selector
- milestone progress
- login condition groups
- slot cards
- other condition cards
- clear status indicators
- next target messaging
- bonus visibility

### 9.3 Glitch fixes already implied by user feedback

Fix or prevent:

- malformed chip / toolbar rendering in Earnings
- slow reactions when switching week/day
- unreadable condition blocks
- confusing fallback states
- false session counting from brief online presence

## 10. Real-time behavior

Rider progress must update when relevant events occur:

- rider goes online
- rider goes offline
- rider completes slot duration
- order accepted
- order rejected
- order cancelled
- order delivered
- shift completed
- shift cancelled

Do not require reopening the app.

## 11. Notifications in rider app

Support non-duplicated rider notifications such as:

- incentive unlocked
- slot starting soon
- login condition completed
- next milestone needed
- warning before likely failure
- final offer completion

## 12. Backend-authoritative rider-visible data

The rider app must only display backend-authoritative values for:

- slot attendance
- slot completion
- session count
- reject count
- cancelled-shift count
- incomplete-shift count
- city slot availability
- late-night fee
- incentive qualification
- incentive award
- payable amount

The client must not directly author:

- earned incentive
- completed slot
- reward amount
- payable amount

## 13. Regression and non-break requirements

Changes to the Rider app must not break:

- order lifecycle
- dispatch
- rider concurrency
- notifications
- GPS
- COD
- immutable ledger
- payout reconciliation
- existing incentive engine
- weekly earnings history
- Firebase authorization

## 14. Acceptance checklist

At minimum, final Rider behavior must prove:

- 1 AM online alone does not count as completed session
- exactly 2 valid completed sessions can satisfy the daily session condition
- only 1 valid completed session fails the daily condition
- 5 minute offline gap is tolerated
- multiple gaps totaling <= 10 minutes are tolerated
- >10 minutes cumulative offline fails slot
- 1 rejection allowed, 2 rejected orders fail
- 1 cancelled booked shift allowed, 2 fail
- 1 incomplete shift allowed, 2 fail
- daily progress resets next service day
- previous day incentive remains in history
- incentive credits exactly once
- retries do not duplicate credit
- `11 PM – 2 AM` attendance works across midnight
- `2 AM – 6 AM` extra pay default works and can be changed by Admin
- disabled city slots are not visible / bookable in rider flow
- Rider earnings screen reflects credited incentive and payable amount correctly

