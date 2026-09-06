# Savrivo developer build — install and test

These three files are Android developer builds. Install all three on a real Android phone running Android 6 or newer:

1. **Savrivo Customer** — the customer food-ordering app.
2. **Savrivo Control** — the owner and restaurant-staff app.
3. **Savrivo Partner** — the delivery-partner app.

## Install

1. Send the three APK files to the phone, or download them from this folder.
2. Open each file and allow the phone's **Install unknown apps** permission when Android asks.
3. If Android says **App not installed** or **not compatible**, uninstall older Feastly/Savrivo copies from the phone first, then install these three files again. Android cannot replace an older copy that was signed with a different developer key.
4. Allow Location and Notifications for the Partner app. Location must be switched on while a partner is online or has an active delivery.

## Recommended first test

1. Create and verify a new customer account in Savrivo Customer.
2. Add a delivery address with a phone number and use the current-location option.
3. Add food to the cart and place a **cash-on-delivery** test order.
4. Sign in to Savrivo Control as the owner, accept the order, move it through preparation, and assign an approved partner.
5. In Savrivo Partner, go online, claim the order, navigate to the restaurant, collect it, then navigate to the customer.
6. Open the customer's order tracking page. Confirm that the rider marker and status update as the partner moves.
7. Complete delivery using the delivery verification step and check that the order is visible in Customer and Control history.

## What this build is

- Version: **3.0.0**
- Android support: **Android 6.0 and newer**
- Includes: customer accounts, Google sign-in bridge, email verification/reset flow, menus, restaurant and item administration, staff roles, delivery-partner approval/KYC flow, locations, order lifecycle, rider assignment, tracking, COD checkout, support, reviews, preferences, and dark mode.

## Before a public Play Store or App Store launch

Do not take real customer payments or advertise this as a live public service yet. It still needs a production backend for trusted prices/discounts, payment verification, delivery OTP verification, background push notifications, production database rule testing, private document storage, real-device QA, store signing, privacy/legal pages, and an iOS build. The local Firebase rules file is prepared but has **not** been published to Firebase.
