# Savrivo Operational Upgrade

This package upgrades the current four-app Savrivo Android/WebView project while preserving the existing authentication fixes and restaurant-owner setup.

## Validation status

- Customer boot smoke: 21 routes
- Admin/Control boot smoke: 15 routes
- Restaurant boot smoke: 10 routes
- Partner boot smoke: 13 routes
- Premium validation: **300 assertions across all 4 apps passed**
- Realtime Database rules: JSON-valid and covered by project validation checks
- Storage rules: existing KYC/media guards retained
- Android APK compilation could not be performed in the ChatGPT runtime because an Android SDK is not installed there. Build on the Mac with `./BUILD_ON_MAC.sh` or the existing `native_android/build_savrivo.sh`.

## Customer app

### Restaurant discovery and card UI
- Cleaner restaurant-card image treatment with a dedicated fallback placeholder instead of a random low-quality food image.
- Fixed title/rating layout so the rating stays near the restaurant name rather than drifting to the far edge.
- City-aware discovery from the saved/current address.
- Serviceability filtering by customer-to-restaurant distance and delivery radius.
- Sorting: recommended, nearby, highest rated, fastest delivery, low delivery fee.
- Recommended ranking favors open/serviceable/nearby restaurants before rating and ETA.

### Pricing
- Global platform-fee default and scoped override resolution.
- Override priority: restaurant-specific -> order-value -> category -> city -> global default.
- Default delivery slabs:
  - 0-2 km: ₹29
  - >2-4 km: ₹39
  - >4-6 km: ₹59
  - >6-8 km: ₹79
  - >8-10 km: ₹99
  - >10-12 km: ₹119
  - >12-15 km: ₹139
- Configurable service radius, small-order fee and late-night fee.
- Delivery-partner tip remains optional and is included in the locked order pricing snapshot.

### Rain pricing
- Google Weather current-conditions lookup for customer coordinates, restaurant coordinates and route midpoint.
- The worst relevant route condition determines the fee.
- Default severity fees: light ₹9, moderate ₹19, heavy ₹29, severe ₹39.
- Rain fee is completely absent from checkout when it does not apply.
- If weather cannot be verified, no rain fee is charged.
- Pricing is refreshed immediately before order placement and then locked into the order snapshot.

### Surge pricing
- Reads a fresh aggregate restaurant workload from `/feastly/restaurantLoad/{restaurantId}`.
- Default surge fees: low ₹9, medium ₹19, high ₹29, cap ₹39.
- City overrides supported.
- High-demand fee is completely absent when demand is normal.

### Privacy and communication
- Order-scoped Customer <-> Restaurant chat.
- Order-scoped Customer <-> Rider chat.
- Phone-number patterns are masked before chat messages are written.
- Real phone numbers are not presented in chat UI.
- Secure-call buttons are shown only when a backend-generated `contactProxy` alias exists.

## Restaurant app

### Multi-restaurant architecture
- One Restaurant APK can serve multiple restaurants.
- Login resolves restaurant membership via `userRestaurants/{uid}` and `restaurantMembers/{restaurantId}/{uid}` with legacy staff fallback.
- Restaurant switcher allows authorized multi-location users to change scope.
- Menu, orders, profile, staff and operational data remain scoped by `restaurantId`.

### Daily operations
- Kitchen operations board for New / Preparing / Ready groups.
- Preparation timing indicators.
- Optional auto-accept for new orders, limited by configured concurrent-order capacity.
- Optional automatic pause when the restaurant reaches configured load.
- Live aggregate workload publication for surge pricing.
- Menu item availability, preparation time, popular flag and archive flow retained.
- Daily sales/order metrics retained.

### Order lifecycle
Normal Restaurant control is:

`Order placed -> Accepted -> Preparing -> Ready for pickup -> Handed to rider`

Restaurant lifecycle events now use the database-compatible `staff` actor role. Restaurant handover updates the rider job pointer so the Partner app can unlock the delivery phase.

### Communication
- Restaurant <-> Customer chat.
- Restaurant <-> Rider chat.
- Phone-number masking in messages.
- Optional proxy-call buttons when a backend-provided alias exists.

## Partner app

### Signup/application fixes
- Mandatory email verification removed from signup/login/application flow.
- Application text fields are persisted as a local draft.
- Selecting/compressing/uploading identity images no longer wipes the already entered text fields.
- Draft survives normal rerenders/reopen; selected file objects still need reselection if Android kills the app process.

### Privacy-aware delivery flow
Before handover, Partner sees pickup information (restaurant location/navigation) but not the customer's exact delivery address.

After Restaurant marks `Handed to rider`, the customer address becomes available. Partner then continues delivery statuses through the rider workflow.

### Earnings
- Completed earning includes delivery earning + 100% of `pricing.tip`.
- Dashboard shows delivery earnings and tips separately.
- History displays the combined partner earning.

### Communication
- Rider <-> Restaurant chat.
- Rider <-> Customer chat.
- Phone numbers masked in messages.
- Customer exact location remains separately gated by handover status.
- Proxy-call buttons appear only when backend aliases exist.

## Admin/Control app

### Operations role
- Routine restaurant lifecycle buttons are removed from rendered Admin UI.
- Admin remains the monitoring, dispatch, support and exception-control surface.
- Rider assignment/dispatch and oversight remain available.

### Pricing & Fees center
Admin can configure:
- Global platform fee.
- City/category/restaurant/order-value platform-fee overrides.
- Every delivery-distance slab.
- Free-delivery threshold and service radius.
- Rain enable/disable, severity fees, probability threshold and city overrides.
- Surge enable/disable, workload thresholds, fee levels, cap and city overrides.
- Small-order and late-night fees.

Restaurant records now carry city/category and operational capacity settings; central pricing no longer depends on each restaurant manually setting platform/delivery fees.

## Realtime Database rules

Rules were expanded for:
- Restaurant memberships and user-to-restaurant links.
- Restaurant-scoped catalog/menu/order access.
- Privacy-safe rider job pointers.
- Rider full-order access only after handover-related statuses.
- Restaurant workload aggregate.
- Optional proxy-contact aliases.
- Order chats for customer/restaurant/rider channels.
- Chat sender/channel permissions and mobile-number pattern rejection.
- New pricing components and pricing context.
- Expanded Admin pricing settings and restaurant operational fields.

## Important production limitations

### Proxy phone calls
Chat privacy and UI support are implemented, but true phone-number proxy calling needs a telephony provider/backend. The app intentionally does not invent or expose a real masked number. A trusted backend should create temporary `contactProxy` aliases for each active order.

### Chat masking
Clients mask common phone-number formats and Firebase rules reject common numeric phone formats. For stronger evasion detection (words, Unicode tricks, social handles, etc.), route messages through a trusted moderation backend before production scale.

### Google Weather
The Customer app uses Google's Weather current-conditions endpoint. Enable **Weather API** in the Google Cloud project and ensure the configured API credential is permitted to call it. If the request fails, Savrivo charges no rain fee.

### Trusted final pricing
The current developer architecture calculates dynamic pricing in the Customer app and validates its shape/total in Realtime Database rules. Before real-money production, move authoritative fee calculation to a trusted backend/Cloud Function and return a short-lived signed price quote.

### Surge signal
The first implementation uses fresh restaurant active-order workload. A future trusted backend can improve surge using private aggregates such as available riders, assignment delay, traffic and city-wide queue pressure without exposing raw rider-presence data to customers.

## Mac validation / deployment / APK build

Unzip the patch over the current `i-n` folder so the existing developer keystore under `native_android/build/` is preserved.

Then from `i-n`:

```bash
./BUILD_ON_MAC.sh
```

This runs validation, Firebase database-rule dry-run, and APK build without deploying rules.

After reviewing the dry-run, use:

```bash
./BUILD_ON_MAC.sh --deploy
```

This deploys the database rules and builds all four APKs.

Expected APKs:

```text
native_android/build/savrivo_developer/Savrivo-Customer-developer.apk
native_android/build/savrivo_developer/Savrivo-Admin-developer.apk
native_android/build/savrivo_developer/Savrivo-Restaurant-developer.apk
native_android/build/savrivo_developer/Savrivo-Partner-developer.apk
```
