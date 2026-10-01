# Google Play Console kit: Scraveit apps

Everything Play Console asks for, ready to paste. Bundles to upload are in
`native_android/build/play-store/` (sign them first, see the final steps).
Graphics are in this folder: `<app>-icon-512.png` (app icon) and
`<app>-feature-1024x500.png` (feature graphic).

Release track: **Internal testing** for every app until SCRAVEIT's FSSAI
licence is issued. Admin stays on internal testing permanently.

Developer: SCRAVEIT PRIVATE LIMITED · Email: balaji@scraveit.in · Website: https://www.scraveit.in
Privacy policy: https://www.scraveit.in/privacy · Account deletion: https://www.scraveit.in/account-deletion

---

## 1. Store listings

Category: **Food & Drink** (Customer), **Business** (all other apps).

### Scraveit (Customer) · com.feastly.app
- **App name:** Scraveit: Food, Grocery & Dairy
- **Short description (80):** Order from restaurants, grocery stores and dairies near you, with live tracking.
- **Full description:**
  Scraveit delivers from partner restaurants, grocery stores and dairies in your town.

  • Browse restaurants, groceries and dairy in one app
  • See every product's price, MRP, net quantity and label details
  • Pay by cash on delivery or online
  • Track your rider live on the map from the moment you order
  • Chat with the store or rider without sharing your phone number
  • Save addresses, favourites and offers; earn wallet cashback

  Every partner store shows its FSSAI licence. Scraveit is operated by SCRAVEIT PRIVATE LIMITED, Nellore, Andhra Pradesh.

### Scraveit Rider · com.feastly.rider
- **App name:** Scraveit Rider: Delivery Partner
- **Short description:** Deliver orders with Scraveit and see your earnings for every trip.
- **Full description:**
  Scraveit Rider is the app for Scraveit delivery partners.

  • Go online and receive nearby delivery requests
  • Navigate to the store and the customer
  • Confirm pickup and delivery with verification codes
  • See pay for every trip, incentives, tips and weekly payouts
  • Invite other riders and earn referral rewards

  To keep customers safe, riders sign up with identity and vehicle documents and confirm their face when they go online. Location is used only while you are online to receive and deliver orders.

### Scraveit Restaurant · com.feastly.restaurant
- **App name:** Scraveit Restaurant: Partner App
- **Short description:** Accept orders, manage your menu and track earnings for your restaurant.
- **Full description:**
  The Scraveit app for restaurant partners.

  • Accept new orders with a loud alert, even when the app is closed
  • Mark orders preparing and ready, and hand over to the rider
  • Manage your menu, prices, photos and availability
  • See a bill for every order with the commission and what you receive
  • Run offers and track settlements

### Scraveit Grocery · com.feastly.grocery
- **App name:** Scraveit Grocery: Store Partner
- **Short description:** Accept orders, manage products and track earnings for your grocery store.
- **Full description:**
  The Scraveit app for grocery store partners.

  • Accept new orders with a loud alert, even when the app is closed
  • Pack orders and hand them to the Scraveit rider
  • List products with MRP, net quantity and full FSSAI label details
  • See a bill for every order with the commission and what you receive
  • Track settlements

### Scraveit Dairy · com.feastly.dairy
- **App name:** Scraveit Dairy: Dairy Partner
- **Short description:** Accept orders, manage products and track earnings for your dairy.
- **Full description:** Same as Grocery, with "dairy" in place of "grocery store".

### Scraveit Admin · com.feastly.admin (internal testing only)
- **App name:** Scraveit Admin
- **Short description:** Internal operations app for the Scraveit team.

Screenshots (2 to 8 per app, phone): take them on the phone from each app's
main screens. Play requires them; they cannot be generated without a device.

---

## 2. App content forms

### Data safety (answer per app)
All apps: data is **encrypted in transit**; users **can request deletion**
(https://www.scraveit.in/account-deletion); data is **not sold** and **not
shared** with third parties for their own use. Service providers that process
data for Scraveit (Google Firebase, AWS face verification, the payment
gateway) count as processing, not sharing.

| Data type | Customer | Rider | Restaurant / Grocery / Dairy | Admin |
|---|---|---|---|---|
| Name, email, phone | Collected, required | Collected, required | Collected, required | Collected |
| Address | Collected (delivery) | Collected | Collected (store) | – |
| Precise location | Collected (address pin, live tracking) | Collected (only while online, incl. in background) | Collected (store pin) | – |
| Photos | Optional (reviews) | Collected (face check, documents) | Collected (menu and product photos) | – |
| Government ID | – | Collected (Aadhaar, driving licence) | – | – |
| Financial info | Payment status only (card details stay with the gateway) | Bank account / UPI for payouts | Bank account, UPI, PAN, GSTIN for settlements | – |
| Purchase history | Collected (orders) | Collected (deliveries) | Collected (orders) | – |
| Messages | Order chat | Order chat | Order chat | – |
| Crash logs, diagnostics | Collected (Crashlytics) | Collected | Collected | Collected |
| Device IDs | Collected (notifications) | Collected | Collected | Collected |

Purposes: app functionality, account management, fraud prevention and
security, analytics (crash logs only).

### Sensitive permissions and declarations
- **Rider · foreground service, location:** "Shares the rider's live location
  with the customer and the dispatch system while the rider is online or on
  an active delivery. Starts when the rider goes online, stops when they go
  offline." Play asks for a short video: record going online, accepting a
  delivery with the map moving, and going offline (the notification appears
  and disappears).
- **Rider, Restaurant, Grocery, Dairy, Admin · foreground service, media
  playback:** "Plays a continuous alert sound for a new order or support alert
  until the user acknowledges it, so it is not missed while the phone is
  locked." If Play rejects this type, the alert must move to a
  full-screen notification; send me the rejection and I will change it.
- **Rider · camera:** face check at sign-up and when going online; document
  photos.
- **Background location:** not requested (no ACCESS_BACKGROUND_LOCATION).

### App access (reviewers must be able to sign in)
Rider, Restaurant, Grocery, Dairy and Admin need an approved account. Create one
test account per app (not your own), approve it in Admin, and enter in Play
Console → App access:
- Login: the test email and password
- Notes: "Sign in with the email and password above. The account is already
  approved. Orders are sample data; no real deliveries happen."
For Rider, the face check needs a real face; add: "If the face check blocks
review, contact balaji@scraveit.in and we will mark the account verified."

### Other forms
- **Ads:** No (the in-app banners are Scraveit's own local promotions, no ad SDK).
- **Content rating:** questionnaire → no violence, no user-generated public
  content (order chat is private), no gambling. Expected rating: Everyone.
- **Target audience:** 18 and over.
- **News app:** No. **Government app:** No. **Financial features:** No
  (payouts to partners are not a financial product).
- **Health:** No.

---

## 3. After the first upload (send these to Claude)

Play Console → each app → Test and release → App integrity → App signing:
copy the **SHA-1** and **SHA-256** of the *app signing key*. Claude adds them
to Firebase so Google sign-in works in the Play Store version.
