# Tax: what still needs a chartered accountant

Scraveit's code does not decide Indian tax law. It can apply whatever
treatment your CA defines, component by component, versioned and dated. This
page lists exactly what the CA must decide before a "component rules" tax
version is switched on.

## What checkout does today

Until a CA-approved version in **component rules** mode is in force, checkout
does what it always did: it applies the flat food rate from **Admin → Pricing &
fees → Tax rate %** to food minus discounts. Nothing else is taxed, and no
invoices or credit notes are generated.

## How a CA-approved version is entered

Admin → Economics → Tax → Add a tax version:

- Version id, effective from and until
- Mode: component rules
- Approved by: CA name / firm (required)
- For each component: rate %, whether the price already includes the tax,
  who is liable (restaurant / Scraveit / not taxable), whether discounts
  reduce the taxable amount, and the HSN/SAC code

Orders keep the version that was in force when they were placed
(`taxVersionId` on the order's economics), so a new version never changes past
orders.

## Decisions the CA must make

| # | Component | Question for the CA |
|---|---|---|
| 1 | Food | Rate on restaurant food supplied through an e-commerce operator. Is Scraveit the one liable to collect and pay it? Which HSN/SAC? |
| 2 | Food discounts | Do restaurant-funded and Scraveit-funded discounts both reduce the taxable value, or only discounts shown on the invoice? |
| 3 | Packaging | Is packaging taxed with food or separately? At what rate? |
| 4 | Delivery fee | Rate and SAC for the customer delivery fee. Is Scraveit the supplier, or the rider? |
| 5 | Platform fee | Rate and SAC. Is the price inclusive or exclusive of tax? |
| 6 | Small-order, late-night, rain, surge and rider-incentive fees | Same treatment as the platform fee or the delivery fee? |
| 7 | Commission | Rate charged to restaurants on Scraveit's commission; how it appears on the restaurant's invoice and settlement. |
| 8 | Tax collected at source | Whether TCS applies to restaurant settlements, at what rate, and how it should be shown and filed. |
| 9 | Tips | Confirm tips are outside the taxable value (the engine treats them as 100% the rider's, never Scraveit revenue). |
| 10 | Wallet / cashback | Whether cashback is a discount (reducing taxable value) or a separate promotional expense, and how wallet redemptions appear on invoices. |
| 11 | Refunds | How refunds and partial refunds are reversed: credit notes, and who issues them (restaurant or Scraveit). |
| 12 | Rider payouts | Whether rider earnings, guarantee top-ups and referral rewards have any withholding or reporting requirement. The rider referral reward is ₹5,000 by default, recorded gross (no deduction) as its own ledger event (`rider_referral_reward`), so any withholding the CA sets can be applied at payout without changing how referrals qualify. |
| 13 | Customer invoice | Required fields; whether one invoice or separate restaurant and Scraveit invoices are needed per order. |
| 14 | Restaurant invoice | Invoice for commission and fees charged to the restaurant: frequency and fields. |
| 15 | Platform invoice | Invoice for Scraveit's own fees to the customer: fields and numbering series. |
| 16 | State | Place-of-supply rules when Scraveit expands beyond Andhra Pradesh. |

## Not built yet (needs the answers above first)

- Customer, restaurant and platform invoice documents with legal numbering
- Credit notes for refunds
- TCS calculation and filing reports
- Tax returns and exports in the formats the CA needs

The engine already records every tax line per order in
`orderEconomics/{orderId}.taxLines`: component, taxable amount, rate, tax,
liable party, collector and HSN/SAC. That is the data these documents will be
built from.
