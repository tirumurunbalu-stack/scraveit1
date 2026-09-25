# Scraveit economics system

How money moves through every Scraveit order, who pays for what, and how the
system keeps orders from losing money and cities from running out of cash.
All amounts are stored as whole paise (₹1 = 100 paise); percentages are basis
points (100 bps = 1%). The backend is the only place money is calculated; the
apps display what it returns.

Companion documents:

- [SCRAVEIT_CITY_PNL_AND_EXPANSION.md](SCRAVEIT_CITY_PNL_AND_EXPANSION.md):
  operating profit, break-even and expansion money
- [SCRAVEIT_ECONOMICS_ADMIN_RUNBOOK.md](SCRAVEIT_ECONOMICS_ADMIN_RUNBOOK.md):
  step-by-step admin tasks
- [SCRAVEIT_TAX_CA_INPUTS.md](SCRAVEIT_TAX_CA_INPUTS.md): what the chartered
  accountant must decide

## Where the code lives

| Piece | File |
|---|---|
| Per-order economics, profit rules, offer funding, guardrail, simulation | `functions/src/domain/economics.ts` |
| Rider trip pay rules | `functions/src/domain/riderTripPay.ts` |
| City / zone customer prices, customer referral programme | `functions/src/domain/customerPricing.ts` |
| Wallet, cashback rules | `functions/src/domain/wallet.ts` |
| City P&L, fixed costs, expansion, break-even | `functions/src/domain/cityFinance.ts` |
| Tax versions (CA-defined) | `functions/src/domain/taxRules.ts` |
| Rider earnings guarantee | `functions/src/domain/earningsGuarantee.ts` |
| Settings document and audited changes | `functions/src/domain/economicsControl.ts`, `functions/src/services/economics.ts` |
| Checkout plan, offer budgets | `functions/src/services/economics.ts`, `functions/src/services/orders.ts` |
| Final trip pay and city/zone attribution at delivery | `functions/src/services/deliverySettlement.ts` |
| Wallet and cashback service | `functions/src/services/wallet.ts` |
| Customer referrals | `functions/src/services/customerReferrals.ts` |
| Rider referrals and guarantees | `functions/src/services/riderRewards.ts` |
| Dashboards, P&L, admin tools | `functions/src/services/economicsAdmin.ts` |
| Ledger | `functions/src/services/ledger.ts`, `functions/src/domain/ledger.ts` |

## 1. One order

```
customer pays   = food − restaurant discount − Scraveit discount
                  + delivery fee + platform / small-order / late-night / rain / surge / rider-incentive fees
                  + tax + tip − wallet money used
restaurant gets = (food − restaurant discount) − commission − tax on commission (if a CA rule sets it)
rider gets      = trip pay + per-order bonuses + tip          (tip is 100% the rider's)
government      = tax                                          (never revenue)
Scraveit keeps  = commission + fees − rider pay − Scraveit discount
                  − payment / cash handling − refund reserve − support − other per-order costs
```

**Contribution** is what Scraveit keeps from one order. It is not profit:
fixed city costs come after it (see the P&L document).

Worked example: Nellore dinner, cash, ₹350 food, ₹25 delivery fee, ₹7
platform fee, 10% commission. The rider's trip is 1.5 km pickup and 4 km drop,
so trip pay is ₹34 (see section 3).

| | ₹ |
|---|---|
| Commission (10% of 350) | 35 |
| Delivery fee + platform fee | 32 |
| Gross revenue | 67 |
| Rider trip pay | −34 |
| Cash handling + support | −5 |
| **Contribution** | **28** |
| Restaurant receives | 315 |
| Delivery margin (₹25 fee − ₹34 pay) | −9 (a delivery subsidy) |

### Every rupee reconciles

```
what the customer paid + Scraveit's own discount + wallet money used
  = restaurant receivable + commission + tax on commission + all customer fees + tax + tip
```

`economicsImbalancePaise()` must be 0, and an order is never written if its
snapshot and total differ by even one paisa. The ledger mirrors this with
balanced double entries:

| Entry | Meaning |
|---|---|
| `expense:platform-promotions` | Scraveit-funded discount |
| `expense:rider-trip-subsidy` | Trip pay above the delivery fee |
| `liability:customer-wallet:{customer}` debit | Wallet money used on the order |
| `liability:tax-payable` | Customer tax plus any tax on commission |

## 2. Frozen terms

At checkout, each order stores:

- `order.economics`: the settlement terms (who pays and gets what, commission
  rate, estimated trip pay). The customer, the restaurant and the rider can
  read their own orders.
- `orderEconomics/{orderId}` (server-only): the full snapshot, including
  Scraveit's costs, contribution and reserves, and the frozen rider pay rules,
  distance and tax lines. At delivery it also stores the rider's final trip
  pay (`riderFinal`), cashback earned, and the outcome (delivered or
  cancelled).

Settlement always reads these frozen terms, never today's settings. Orders
placed before this system existed settle exactly as before.

## 3. Rider trip pay (separate from the customer delivery fee)

```
distance pay = base pickup pay
             + pickup ₹/km × (pickup km − free pickup km)
             + drop ₹/km × (drop km − free drop km)
             + long-distance ₹/km × (drop km − long-distance threshold)
distance pay × vehicle multiplier, then lifted to the minimum / capped at the maximum
trip pay     = distance pay + waiting pay + time-slot pay (late night / early morning)
waiting pay  = min(cap, ₹/minute × (minutes waited − free minutes))
```

Defaults: ₹20 base, ₹4/km pickup after 1 km, ₹6/km drop after 2 km, ₹3/km
extra beyond 7 km, ₹25 minimum, no maximum, and waiting at ₹1/min after 10
minutes capped at ₹30.

| Trip | Pay |
|---|---|
| 1.5 km pickup, 4 km drop | 20 + 2 + 12 = **₹34** |
| 0.3 km pickup, 0.8 km drop | ₹20, lifted to the **₹25** minimum |
| 1 km pickup, 10 km drop | 20 + 48 + 9 = **₹77** |
| 3 km pickup, 4 km drop, 25 min wait | 20 + 8 + 12 + 15 = **₹55** |

Rules can be set globally, per city and per zone, each as a dated version, so
new orders use new rules and old orders keep theirs.

- **At checkout** the pay is an estimate: expected pickup distance, the real
  drop distance, and no waiting.
- **At delivery** it is finalised once: the rider's real pickup distance from
  dispatch, waiting time from verified restaurant arrival to handover, the
  rider's vehicle, and the delivery time. The result is stored, so retries
  always settle the same amount.

What the customer pays for delivery is a separate price list (section 5). The
difference is always shown:

| Customer pays | Rider earns | Result |
|---|---|---|
| ₹25 | ₹34 | ₹9 delivery subsidy (booked as rider trip subsidy) |
| ₹40 | ₹31 | ₹9 delivery margin (kept as Scraveit fee revenue) |
| ₹0 (free delivery) | ₹34 | ₹34 subsidy; the rider is still paid in full |

Rain, surge, peak and special bonuses stay in rider incentive campaigns. Tips
always go 100% to the rider.

## 4. Who pays for a discount

| Funding | Restaurant pays | Scraveit pays | Commission |
|---|---|---|---|
| Restaurant | all | nothing | on the discounted amount |
| Scraveit | nothing | all | on the full amount |
| Shared | its agreed share | the rest | after the restaurant's share |

A restaurant's money is only spent on offers that name it. Offers created in
the Restaurant app are always restaurant-funded. Offers saved before this
system existed stay restaurant-funded.

**Profit guardrail.** A Scraveit-funded discount is capped per order at
`contribution before promotion − minimum contribution`, and at the per-order
subsidy maximum. Anything more comes only from an approved growth budget;
otherwise it is withheld, and the customer sees the real discount before
ordering.

Offer budgets and one-per-customer limits are reserved in the same database
transaction as the order, and released once if the order is cancelled.

## 5. Customer prices per city and zone

The global price list (Admin → Pricing & fees) can be overridden per city and
per zone:

- delivery fee slabs, free delivery above, platform fee
- minimum order, small-order threshold and fee
- late-night fee, surge on/off and amounts, rain fee on/off
- delivery radius

These set customer prices only; they never change rider pay.

## 6. Wallet, cashback and referrals

**The wallet** holds lots of money owed to a customer. Each lot records who
funded it (Scraveit, a restaurant, or both) and when it expires. Every
movement is an immutable wallet entry and a financial ledger journal.

**Cashback** is earned only after delivery, exactly once per order, from the
best eligible campaign. Funding options:

| Funding | Cost falls on |
|---|---|
| Scraveit budget | `expense:cashback`, capped by the campaign budget |
| Restaurant / shared | The named restaurant's payable (its share) |
| Each order's safe profit | At most the allowed share of `contribution − minimum contribution` (e.g. ₹25 × 20% = ₹5, never the ₹50 asked for) |

Limits: minimum order, maximum cashback, per-customer uses, first order only,
city / zone / restaurant scope, dates, a daily earning cap per customer, and a
fraud block (`customerRisk/{uid}.blockRewards`).

- **Using wallet money:** only when the customer turns it on, up to the wallet
  rules (default 20% of food, at most ₹100, on orders above ₹149).
  Earliest-expiring money is spent first, and at least ₹1 always stays
  payable. It is reserved in the order transaction and given back exactly
  once if the order is cancelled.
- **Refund reversal:** a refund takes back whatever of that order's cashback
  is still unspent. What was already spent is recorded as unrecovered.
- **Expiry:** runs nightly. Scraveit-funded money becomes
  `revenue:wallet-breakage`; restaurant-funded money goes back to the
  restaurant.

**Customer referrals.** Every customer has a code (`SC` plus 6 characters) and
a share link.

- A new customer applies a code before their first order. Both people are
  rewarded, in their wallets, only after the new customer's qualifying
  delivered order (minimum orders and value, within N days), exactly once,
  within the programme budget.
- Signup rewards are off unless deliberately enabled.
- Fraud signals are checked when a code is applied: same device, same phone,
  an address within 100 m, and a device already used for another referral.
  Flagged referrals wait for admin review.
- The payment-account signal is not available yet.

**Rider referrals.** ₹5,000 to the inviter after the referred rider's 250th
successful delivered order. Both are defaults that can be changed in Admin
(More → Rider rewards); they are stored as integer paise (`500000`) and a
count (`250`). The pure rules are in `functions/src/domain/riderReferral.ts`.

Each referral is one record, `riderReferrals/{referredRiderId}`:

- **Created once**, when the referred rider submits their application (the
  `riders/{uid}` trigger), or at their first delivery if they applied before
  these records existed. The inviter can never be switched afterwards; the
  Firestore rules also stop a rider changing `referredByCode` once set.
- **Terms frozen on the record:** programme version, reward, deliveries
  needed, deadline, programme dates, city/state/country. Changing the reward,
  deliveries or deadline in Admin starts a new programme version
  (`riderReferralProgrammeVersions/{version}`) that applies only to referrals
  accepted from then on.
- **Budget reserved at acceptance.** The reward is reserved from
  `programBudgets/rider_referral` in the same transaction that accepts the
  referral, together with the per-inviter limit (referrals in progress count
  toward it). If the budget cannot cover one more reward, the referral is
  recorded as not eligible and the rider app shows the programme as full, so
  nobody works toward money that is not there. The reservation becomes spent at
  qualification and is released if the referral expires or is rejected.
- **Counting.** Each qualifying order is counted once, through
  `riderReferrals/{id}/countedOrders/{orderId}`, created in the same
  transaction that adds to the count. A qualifying order is `Delivered`, by that
  rider, not refunded, and not marked as a test or fraud order. Retried
  delivery events, cancelled orders and duplicates never count. A refund while
  the referral is open removes that order from the count. The app never sends
  a count.
- **Qualification and payment.** At exactly the target the referral becomes
  `qualified` (reserved → spent) and the reward is credited with a journal
  whose id is fixed per referred rider (`rider-referral:{referredRiderId}:inviter`),
  then marked `paid`. Retries, orders 251 and 300, concurrent runs and settings
  changes cannot pay again.
- **Fraud signals.** A matching phone, PAN, vehicle, address, email or payout
  account between inviter and referred rider only holds the reward in
  `review` for an admin decision (Economics → Rider referrals). Self-referral
  and test accounts (`testAccount: true`) are never eligible. Nobody is banned
  on these signals.
- **Optional deadline** (days to qualify). Deliveries after it do not count;
  a daily job expires open referrals past their deadline and releases their
  budget.

Statuses: `in_progress`, `review`, `qualified`, `paid`, `expired`, `rejected`,
`not_eligible`. Riders who signed up with a code but have not submitted their
application appear to the inviter as "applying".

**Riders who applied earlier.** Settings saved before versioning that still held
the old defaults (₹500 / 25) are read as the new defaults; those old values
become the legacy terms, and custom values an admin had set are kept.
Riders who applied before 25 September 2026 IST keep the ₹500 / 25-order
terms (version 1). A reward paid by an earlier release (old guard record or
journal) is recorded as paid and never paid again.

**Where the money goes.** The journal debits `expense:rider-rewards:referral`
and credits `liability:rider-earnings:{inviter}`, so the reward is in the
inviter's payable earnings, earnings history, weekly view and next payout as a
separate "referral reward" line. It is not trip pay, a bonus, a guarantee top-up
or a tip, and it is never mixed with cash-on-delivery money the rider holds.
The journal carries `referralId`, `programmeId`, `programmeVersion`,
`inviterRiderId`, `referredRiderId`, country, state, city, zone (when known),
`costCategory: rider_acquisition` and `budget: rider_supply`. It is a
period-level rider acquisition cost: it lowers the city's operating profit for
the period, never the contribution of the order that happened to be the 250th.
By default it does not count toward the earnings guarantee.

## 7. City and zone on every financial entry

New delivery, cashback, wallet, referral, bonus and guarantee journals carry
the country, state, city and zone, plus the order, restaurant, rider,
customer and campaign where they apply. The city dashboard counts only
entries for the chosen city. Older entries without a city are shown separately
as "unattributed", never guessed into a city. The city registry (Nellore →
Andhra Pradesh → India) is part of the economics settings.

## 8. Profit targets

Per order:

- minimum contribution (₹ and optional %)
- target contribution (₹ and optional %; the higher one applies)

Per city, per month:

- minimum and target operating profit
- minimum and target expansion money

City status is Loss, Break-even, Below target or Healthy. See the P&L document.

## 9. Rider earnings guarantee

A guarantee is a **top-up**, never a bonus added on top:
`top-up = max(0, guaranteed − eligible earnings)`.

| Eligible earnings | Guarantee | Top-up |
|---|---|---|
| ₹1,340 | ₹1,680 | ₹340 |
| ₹1,850 | ₹1,680 | ₹0 |

- Only the highest tier reached counts.
- Only deliveries inside the campaign's time slots count.
- All campaign conditions apply.
- Tips are excluded by default.
- The budget can't be overspent, and the number of riders covered per period
  is capped.
- The top-up is booked to `expense:rider-guarantee-topups` in the rider's
  city.

## 10. Tax

Tax rules are versioned and dated, and entered only after a CA approves them
(see the tax document). Until then checkout applies the flat food rate as
before.

In component mode each component has its own rate, inclusive/exclusive
setting, liable party and discount treatment:

- Customer-side tax is added to the bill.
- Tax on commission is withheld from the restaurant.
- Each order stores its tax lines and version.

## 11. Races and retries

| Risk | Protection |
|---|---|
| Two customers take the last of an offer budget | Re-checked in the order transaction; the loser re-prices |
| Wallet balance spent by two orders at once | Lots re-read in the order transaction; the second order is refused |
| Cashback, referral or expiry retried | Deterministic wallet-entry ids and ledger journal ids |
| Final trip pay recomputed differently on retry | Stored once in `orderEconomics.riderFinal` |
| Guarantee or referral paid twice | Guard records plus journals written only if absent |
| Referral order counted twice | One `countedOrders/{orderId}` marker, created in the counting transaction |
| Two referrals take the last of the referral budget | Reserved in the acceptance transaction; the second is not eligible |
| Two admins change settings at once | `expectedRevision`; the stale save is rejected |

## 12. Switches

In `economicsControl/current.flags`: economics engine, profit guardrail, rider
guarantees, restaurant offers, and which cities are enabled. All default to
on.
