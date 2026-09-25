# Scraveit economics: admin runbook

How to set up money rules, offers and campaigns in the Admin app safely. Every
change asks for a reason and is recorded with who made it and its old and new
values (Admin → Economics → Change history).

Everything below is under **Admin → More → Economics** unless stated
otherwise.

## Before launch in Nellore

1. **Profit rules → All cities.** Replace the default costs (gateway 2%, cash
   handling ₹3, refund reserve 1%, support ₹3, other ₹2) with your real ones.
   Set the minimum contribution (₹8) and target (₹20) per order.
2. **Profit rules → One city → `nellore`.** Set the reserve split if it should
   differ from the defaults.
3. **Rider pay.** Add a Nellore version of the trip pay rules: base pay, per-km
   rates, minimum, waiting pay, and any late-night / early-morning pay.
4. **Zones.** Set Nellore's customer delivery slabs, platform fee, minimum
   order and delivery radius. Override busy or far zones where needed.
5. **Restaurant plans.** Add each founding partner's commission plan.
6. **P&L & expansion.** Record every fixed cost (rent, salaries, software,
   marketing) and set Nellore's expansion rules and monthly targets.
7. **Cashback & referrals.** Set the wallet rules. Decide whether the
   customer referral programme runs, and its rewards and budget.
8. **Rider rewards** (More → Rider rewards). Check the rider referral:
   ₹5,000 after 250 successful deliveries by default. Set its budget, cities,
   dates and maximum rewards per inviter. Then use Economics → Rider referrals →
   "What would more referrals cost?" before opening it.
9. **Tax.** Leave it until your CA has answered
   [SCRAVEIT_TAX_CA_INPUTS.md](SCRAVEIT_TAX_CA_INPUTS.md).

## Rider trip pay

Rider pay → choose All cities, One city or One zone. Fill only the fields you
want to change, set **Effective from**, give a reason, then **Add version**.

- Distances are in km, amounts in ₹.
- Time-slot pay format: `23:00-02:00=15, 02:00-06:00=10`.
- Vehicle pay format: `bicycle=120` (120% of distance pay).
- A new version affects only orders placed after its start date.
- Check the effect on the City dashboard: **Delivery margin** below zero
  means delivery is being subsidised.

## Customer prices for a zone

Zones → pick the zone (or type its key) → Customer prices. Fill only what
changes:

- delivery slabs, like `2:29, 4:39, 6:59`
- free delivery above, platform fee, minimum order
- small-order fee, late-night fee, surge and rain on or off, delivery radius

Zone profit rules are under Profit rules → One zone (`nellore|zonekey`).

## Customer offer paid by Scraveit

Promotions → Add → Who pays: **Scraveit**.

1. Set the discount, minimum order, uses per customer and total budget.
2. Tap **Check the numbers**. Green is safe, yellow is below target, red
   loses money.
3. If it is red, choose one: lower it, share it with a restaurant, attach an
   owner-approved growth budget, or tick "publish anyway". Customers then get
   only the safe part, never a loss.

## Customer offer paid by a restaurant

Either the restaurant creates it (Restaurant app → More → Your offers), or you
create it in Promotions with "Who pays: the named restaurants" and their IDs.

- Offers above the auto-approval limit wait in Promotions for Approve or
  Reject.
- Restaurants see each offer's results in the same screen: orders, new
  customers, sales, and what they and Scraveit each funded.

## Shared offer

Promotions → Who pays: **Shared**, the restaurant's share %, and the
restaurant IDs. Only Scraveit's part is limited by the profit check.

## Cashback

Cashback & referrals → New cashback campaign. Who funds it:

- **Scraveit, from a budget**: set a budget.
- **Each order's own safe profit**: set the share of safe profit (e.g. 20%).
  Cashback can never exceed that share of what the order actually earned.
- **The named restaurants / Shared**: the restaurant IDs are required.

Set % or flat amount, maximum, minimum order, uses per customer, days the
money stays usable, cities and zones, and dates.

Cashback is added to the wallet after delivery and taken back if the order is
refunded.

**Wallet rules:** the most of an order that can be paid from the wallet, the
minimum order, the daily cashback cap per customer, and expiry.

**Blocking a customer from rewards:** set `customerRisk/{uid}.blockRewards =
true` in the Firebase console. There is no Admin screen for this yet.

## Customer referrals

Cashback & referrals → Customer referrals:

- Set the inviter reward and the new customer's reward.
- Set the delivered orders and minimum order value needed, the days allowed
  to qualify, how long rewards stay usable, the budget, cities and dates.
- Leave **Reward at signup** off.
- Referrals flagged for the same device, phone or address wait under
  **Referrals to review**. Approve or reject each one.

## Rider referral

**Settings:** More → Rider rewards → reward settings.

- Inviter reward (default ₹5,000), invitee reward (default ₹0), successful
  deliveries required (default 250) and days to reach it (0 = no deadline).
- Maximum rewards per inviter. Referrals still in progress count toward it.
- Programme budget, cities, and start and end dates.

Changing the reward, deliveries or deadline starts a new programme version.
Referrals already accepted keep the terms they joined under. Budget, dates and
cities affect only new referrals.

**Budget.** Each accepted referral reserves its full reward straight away. When
what is left cannot cover one more reward, new referrals are not accepted and
riders see "full". Already accepted referrals are still paid. To reopen, raise
the budget.

**Economics → Rider referrals** shows:

- the programme's status (open, paused, ended, budget full) and version
- budget, paid, reserved, remaining
- potential future liability, qualified-but-unpaid, paid, this month's spend
- average cost per activated rider and per qualifying rider
- the most one inviter can earn (maximum rewards × reward)
- every referral: inviter, referred rider, code, version, deliveries / target,
  reward, city, status, dates and ledger journal ids

Referrals marked **Needs review** reached the target, but the new rider shares
a phone, PAN, vehicle, address, email or payout account with the inviter.
Approve to pay, or reject to release the budget.

**Cost simulation:** enter expected new referred riders and the share
expected to reach the target. It shows expected and worst-case cost at the
current reward, whether the budget covers it, and the effect on the city's
monthly operating profit and expansion fund.

**Test accounts:** set `testAccount: true` on the rider's `riders/{uid}`
document. Referrals involving that rider are never paid.

## Rider bonus, rain and surge

Rider rewards → New campaign → per-order bonus. The customer rain or surge
fee is set separately under Zones or Pricing & fees. The dashboard shows
whether rain made or lost money.

## Rider minimum earnings guarantee

Rider rewards → New campaign:

1. Type **milestone**, with milestones as the guarantee tiers.
2. Advanced settings → payout mode **Earnings guarantee (pay only the
   shortfall)**.
3. Choose what counts (leave tips out), and set the budget and the number of
   riders covered per period.
4. Tap **Estimate guarantee cost** to see the expected and worst-case cost.

Turn off **Rider earnings guarantees** under Profit rules → Switches to pause
payments without losing them.

## Growth budget (deliberate loss)

Owner only. Growth budgets → Approve a budget. Attach it to an offer. The
dashboard shows the spend as **Growth investment** and subtracts it from
operating profit.

## Checking whether Nellore makes money

City dashboard → `nellore` → 30 days:

- **City P&L status:** Loss, Break-even, Below target or Healthy.
- **Operating profit** and **Expansion fund:** the real answer to "how much
  can Nellore give the next city".
- **Delivery margin**, rider costs, cashback and referral costs.
- **Zones:** tap a zone for its orders, revenue, rider and promotion cost,
  refunds, contribution per order, distance and repeat profitable orders.

**P&L & expansion → Break-even calculator.** Leave fields empty to use
Nellore's real figures. It shows the orders per day needed to cover fixed
costs, and the expansion money at your current volume.

## If something looks wrong

- Settings history: Economics → Change history.
- One order's full breakdown: `orderEconomics/{orderId}` in the Firebase
  console. It includes `riderFinal` (the rider's final trip pay and how it was
  worked out), `cashback` and `taxLines`.
- Wallet movements: `walletEntries` (one per movement, never edited).
- Money: `ledgerJournals`. Every new entry carries `cityKey` and `zoneKey`.
