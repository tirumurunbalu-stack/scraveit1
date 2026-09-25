# Is Nellore profitable, and how much can it give the next city?

The short version:

```
revenue − variable costs          = contribution        (per order)
contribution − fixed city costs   = operating profit    (per city, per month)
operating profit − reserves       = allocatable profit
allocatable profit × expansion %  = expansion fund
```

**Contribution is not profit.** A city where every order makes money can still
lose money every month once rent, salaries, marketing and software are paid.

## 1. Contribution: what one order leaves

For each order, Scraveit earns:

- commission on the food (after any restaurant-funded discount)
- the customer's platform fee, delivery fee, and rain, surge, late-night and
  small-order fees

and pays:

- the rider's trip pay (from the rider pay rules, **not** the delivery fee)
  and per-order bonuses
- the payment gateway (online) or cash-handling cost (cash on delivery)
- the refund reserve, support and other per-order costs
- any Scraveit-funded discount

Tips, tax and the restaurant's share are never Scraveit's money.

At the city level, the dashboard also subtracts what is paid per period rather
than per order: milestone bonuses, guarantee top-ups, rider and customer
referral rewards, and cashback (expired wallet money comes back). Each of these
is now recorded with the city it belongs to, so Nellore's figures never
include another city's costs.

A rider referral reward (₹5,000 by default) is a **rider acquisition cost**.
It is charged to the city where the referred rider works, in the period it is
paid, not to the order that happened to be their 250th delivery. At ₹18
contribution per order, one ₹5,000 reward costs the profit of about 278 orders.
Check Economics → Rider referrals → "What would more referrals cost?" before
raising the budget.

## 2. Fixed costs: what the city costs to run

Admin → Economics → **P&L & expansion** → Add a fixed cost.

| Category | Examples |
|---|---|
| Staff & payroll | City manager, onboarding and support staff (their share of time) |
| Office & rent | Office, storage |
| Cloud & infrastructure | Firebase, maps, SMS, this city's share |
| Customer support | Call centre, WhatsApp tools |
| Marketing | Reels, posters, influencers, launch events |
| Accounting / Legal & compliance | CA fees, registrations, licences |
| Banking & software | Payment gateway fixed fees, subscriptions |
| Equipment | Bags, T-shirts, phones (one-off) |

Monthly costs are spread evenly across the days of each month, so a 7-day
view carries 7/30ths of the rent. One-off costs count in the period they fall
in. Record the proof or invoice number in "Proof / reference".

## 3. Operating profit and city health

```
operating profit = contribution − growth investment − fixed costs
```

Growth investment is money from an approved growth budget: a deliberate
loss, such as launch-week offers. It is shown separately and still subtracted
here, because it is real cash spent.

The city status uses your monthly targets (scaled to the period you view):

| Status | Meaning |
|---|---|
| **Loss** | Operating profit is below zero |
| **Break-even** | Costs are covered but profit is below the minimum monthly target |
| **Below target** | Profitable, but below the target profit, or not yet producing the minimum expansion money |
| **Healthy** | Meets the target operating profit and funds expansion |

A city is never "healthy" just because every order had positive
contribution.

## 4. The expansion fund

Admin → Economics → P&L & expansion → **Expansion money rules** (per city):

```
risk reserve          = operating profit × risk %            (default 15%)
working-capital       = operating profit × working capital %  (default 15%)
allocatable profit    = operating profit − risk reserve − working capital
expansion fund        = allocatable profit × expansion %      (default 40%)
retained earnings     = allocatable profit − expansion fund
```

Allocation mode:

- **City operating profit** (recommended, the default): exactly the formula
  above.
- **Order contribution** (legacy): reserves are calculated on contribution,
  but the expansion fund is still capped by the city's real operating profit.
  It can never be more than the city actually made.

**"How much cash can Nellore safely provide for opening the next city?"**
It is the **Expansion fund** line on the city P&L for the period you choose.
Add up the months to see what has built up.

## 5. Break-even

Admin → Economics → P&L & expansion → **Break-even calculator**. Leave a field
empty and it uses Nellore's real last-30-day averages and your recorded fixed
costs.

```
contribution per order = commission + customer fees
                         − rider cost − promo cost − payment cost − refunds − other
break-even orders/month = fixed monthly costs ÷ contribution per order
break-even orders/day   = that ÷ 30
```

Worked example, the same as the automated test:

| | |
|---|---|
| Contribution per order | ₹18 |
| Fixed Nellore costs | ₹1,80,000 / month |
| Break-even | 1,80,000 ÷ 18 = 10,000 orders/month ≈ **334 orders/day** |
| At 600 orders/day | 18 × 600 × 30 = ₹3,24,000 contribution/month |
| Operating profit | ₹3,24,000 − ₹1,80,000 = ₹1,44,000 |
| Expansion at 40% (no reserves) | ₹57,600 / month |

With the default 15% risk and 15% working-capital reserves, the same month
gives ₹1,44,000 − ₹21,600 − ₹21,600 = ₹1,00,800 allocatable, so ₹40,320 for
expansion.

If contribution per order is zero or negative, the calculator says
break-even is **not reachable**. More orders only lose more money, so fix unit
economics first.

## 6. How much can safely go on promotions

Three limits apply:

1. **Per order**: a Scraveit-funded discount can be at most
   `contribution before promotion − minimum contribution`, and never more than
   the per-order subsidy cap. Checkout enforces this on every order.
2. **Per campaign**: each offer's own budget.
3. **Per city, per month**: whatever keeps operating profit above your
   minimum monthly target. Use the break-even calculator's "promo cost per
   order" field to test it: raise it until monthly operating profit falls to
   your minimum. That is the most promotion spend the city can carry.

Anything beyond that is a deliberate loss and must come from an approved
growth budget.

## 7. How rider cost changes everything

Rider cost is usually the largest cost per order. Customer delivery fees and
rider pay are now separate:

| Customer pays | Rider earns | Effect on Scraveit |
|---|---|---|
| ₹25 delivery | ₹34 trip pay | **₹9 delivery subsidy** per order |
| ₹40 delivery | ₹31 trip pay | **₹9 delivery margin** per order |
| Free delivery | ₹34 trip pay | ₹34 subsidy per order |

The dashboard shows the total as **Delivery margin**. Every ₹1 of extra
average rider cost moves break-even by roughly `fixed costs ÷ contribution²`
orders. At ₹18 contribution and ₹1,80,000 fixed, ₹1 more rider cost per order
(₹17 contribution) raises break-even from 334 to about 353 orders a day.

## 8. Monthly routine

1. Record every fixed cost for the month (P&L & expansion).
2. Open the City dashboard for "30 days".
3. Read the city status, operating profit and expansion fund.
4. If the city shows Loss or Break-even, check delivery margin, rider cost per
   order, promotion and cashback spend, and orders below the minimum
   contribution.
5. Move the expansion fund amount to the expansion account. Keep the risk and
   working-capital reserves in the city's operating account.
