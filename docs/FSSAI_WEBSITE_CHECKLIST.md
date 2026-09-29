# FSSAI queries: what each one needs, and where the website answers it

Application 10260921109099066 · SCRAVEIT PRIVATE LIMITED · www.scraveit.in
Replies to paste: [FSSAI_QUERY_RESPONSES.md](FSSAI_QUERY_RESPONSES.md)

| # | FSSAI query | What they need to see | Where on the website | Status |
|---|---|---|---|---|
| 1 | No products displayed / offered for sale | Stores and products with prices, and a way to buy | /shop → Restaurants, Groceries, Dairy (bottom bar) → store → product → cart → demo checkout → demo order | Done. All listings are marked samples; ordering opens after the licence |
| 2 | FSSAI Order dt. 18.03.2026 (ONDC) | That e-commerce FBO obligations are met | /fssai, /how-it-works, seller licence on every store and product page | Done on the site. **You confirm** in the reply whether SCRAVEIT is on ONDC |
| 3 | Business model and inventory storage | How the model works; where stock is kept | /how-it-works ("Who does what", "How an order moves", "Inventory and storage") | Done. States no inventory, no warehouse, office is administrative only |
| 4 | FC 13, 99, 16: what is sold | Products under each category | /how-it-works → "Food categories on the platform" | Done on the site. **You confirm** the 13 and 99 examples, or drop those categories |
| 5 | PDP with mandatory labelling (LDR 2020) | Every label field on each product page | Every product page, e.g. /shop/item/sample-dairy/paneer-200g | Done. Name, brand, veg mark, net qty, MRP, ingredients, nutrition, allergens, category, storage, shelf life, best before, manufacturer + FSSAI no., origin, seller + FSSAI no., customer care |
| 6 | Upload GST certificate | GST registration | Not a website item | **You upload it** (the application says "GST No: Not provided") |
| 7 | Documentary proof when ready | Evidence of the above | Screenshots of the pages in this table | **You take screenshots** and attach them |
| 8 | Website/app must be verifiable | A working site to inspect | Whole site is live | Done |

## The purchase flow an officer can click through

1. www.scraveit.in → **Order now**, or www.scraveit.in/shop
2. Bottom bar: **Restaurants · Groceries · Dairy**
3. Open a store: menu or product list with prices, the seller's name, address and FSSAI licence line
4. Open a product: price, MRP, full label panel, **Add to cart**
5. **Cart**: quantities, item total, note that ordering opens after the licence
6. **Continue to demo checkout**: delivery address, delivery time, payment options (cash on delivery, UPI, card), full bill (item total, delivery fee, platform fee, taxes, total)
7. **Place demo order**: confirmation with order number, delivery code and a status timeline (placed → accepted → preparing → out for delivery → delivered)
8. **My orders**: lists the demo order

Every demo step says no order is placed, no payment is taken and no seller is contacted.

## Also on the site

- Grievance officer (Consumer Protection (E-Commerce) Rules, 2020): /grievance, balaji@scraveit.in
- Refunds and cancellation: /refunds · Delivery policy: /delivery-policy · Terms: /terms · Privacy: /privacy
- Footer on every page: legal name, CIN, registered office, FSSAI application status

## Before pressing Submit on FoSCoS

- [ ] Click through steps 1–8 above yourself, on a phone and a computer
- [ ] Read /how-it-works, /fssai and the policies; they are your declaration
- [ ] Confirm the ONDC statement (query 2) and the category 13 / 99 examples (query 4)
- [ ] Upload the GST certificate (query 6)
- [ ] Attach screenshots (query 7)
- [ ] Check that balaji@scraveit.in receives mail (it is the grievance and contact address)

## At launch (after the licence is issued)

- Replace sample stores and products with real, onboarded partners and their real label data
- In `website/public/shop/web-config.js`: set `ordersOpen: true` and add the App Check key
- Firebase console: add www.scraveit.in to Auth authorized domains; register the web app in App Check
- Show SCRAVEIT's FSSAI licence number in `web-config.js` (footer) and on /fssai
