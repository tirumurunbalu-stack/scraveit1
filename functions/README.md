# Savrivo Firebase backend foundation

This package adds a server-authoritative Firebase Functions v2 backend without changing or deploying the current apps, Firebase project, Realtime Database data, rules, or billing. Every operational path remains below `/feastly` for compatibility.

## What is implemented

- `createCodOrder`: App Check-protected callable that reads the current restaurant, normalized menu (with embedded-menu fallback), saved customer address, promotion, pricing settings, restaurant load and backend weather signal. The client cannot submit item prices, fees, discounts, totals, customer identity, restaurant identity or payment state.
- Deterministic order IDs and RTDB transactions make retries idempotent. Canonical customer orders remain at `/feastly/orders/{customerId}/{orderId}` and are mirrored to `/feastly/restaurantOrders/...`.
- Delivery OTP plaintext, verifier and salt are never written to a new canonical or mirrored order. They live only at the server-owned `/feastly/private/deliveryOtps/{orderId}` path. Existing public verifier fields are migrated before being scrubbed, so active legacy orders remain deliverable without leaving a four-digit offline-verification target in reader-visible data.
- `updateOrderStatus`: lifecycle/RBAC callable matching the existing Savrivo status strings. It verifies custom owner/admin claims, both current restaurant membership layouts, staff permissions, approved rider assignment, delivery OTP and COD collection.
- `onOrderCreated` and `onOrderUpdated`: reconcile mirrors and fan out FCM events to restaurant, customer and rider devices. Restaurant alerts carry stable alarm IDs and an explicit stop event.
- `registerPushToken` and `unregisterPushToken`: App Check-protected token lifecycle. The backend hashes token keys, validates app/platform metadata, enforces the authenticated Customer/Restaurant/Rider/Admin role, and caps each account at 20 devices.
- `onRiderPresenceUpdated` maintains a bounded city availability index. `claimRiderOrder`, `dispatchOfferTimeout` and the Ready-for-pickup trigger use it to rank fresh online approved riders by restaurant distance and active load, offer sequentially for 30 seconds, claim transactionally, cancel competing offers, and create the existing `/feastly/riderJobs` record.
- `onTrackingUpdated` accepts proximity evidence only from the authenticated, approved rider assigned to that exact order. It rejects stale, replayed, inaccurate and implausible movement; calculates distance to the server-stored drop point; and requires two separated fixes within 700 m for `Near you` and three within 100 m for `Arrived`. Evidence and pending transitions are idempotently retained under `/feastly/private/trackingEvidence`; status changes use the same transactional lifecycle and therefore flow through `onOrderUpdated` for the mirror, rider job and customer notification.
- Rider jobs are backend-owned minimum projections. Before handover they contain only the restaurant and approximate drop zone. During an active delivery they add the exact address and required order fields but never `customerPhone`; terminal jobs are redacted again. `contactProxy` is supported only when a future number-masking provider supplies it.
- Restaurant order mirrors are privacy projections rather than canonical copies: they omit `customerPhone` and expose only address label/area/city. Restaurant communication must use in-app chat or a future `contactProxy`; the exact drop address remains canonical/admin-only and appears in the assigned rider job only after handover.
- Restaurant workload and surge inputs are reconciled idempotently from canonical order events under `/feastly/private/restaurantWorkload`. Pricing ignores the client-visible `/feastly/restaurantLoad`; Functions update that node only as a dashboard compatibility projection.
- Delivered COD orders create one idempotent rider-wallet ledger entry and increase the pending-return balance once. Dispatch refuses wallets marked `codBlocked` or `orderBlocked`; the client must define the return window/settlement policy before a scheduled overdue blocker is enabled (the backend does not invent a financial deadline).
- PhonePe has an explicit gateway interface and fail-closed stub. It cannot create an intent or mark a payment paid. A callback can reach `paid` only after a real adapter independently authenticates the callback, queries PhonePe status, checks merchant order ID and amount, and returns a typed `verified: true` event.

## Required client integration

After sign-in and FCM token creation/refresh, call `registerPushToken`:

```json
{
  "token": "<FCM registration token>",
  "app": "customer",
  "platform": "android",
  "appVersion": "1.0.0",
  "deviceModel": "optional model"
}
```

Use exactly one allowed app value (`customer`, `restaurant`, `rider`, or `admin`) and one platform value (`android` or `ios`).

On sign-out or explicit notification disable, call `unregisterPushToken` with `{"token":"<same token>"}` before clearing the authenticated session. Clients must never write `/feastly/deviceTokens` directly.

The Customer app should replace direct RTDB order creation with callable `createCodOrder`:

```json
{
  "idempotencyKey": "a-stable-random-value-kept-until-result",
  "restaurantId": "the-waffle-spot-naidupeta",
  "addressId": "saved-address-id",
  "items": [
    {"itemId": "bean-vanilla", "quantity": 2, "addOnIds": [], "note": ""}
  ],
  "couponCode": "",
  "tip": 0,
  "deliveryMode": "asap",
  "instructions": "",
  "contactless": false
}
```

Keep the same idempotency key if a request times out. Store the returned delivery OTP only in protected local storage and show it only on the active order page.

The `deliveryOtp` is a separate authenticated callable result, not part of `order`. Do not copy it, a hash, or a salt into `/orders`, `/restaurantOrders`, analytics, logs, crash reports, notifications, or rider jobs.

Restaurant/Admin/Rider apps should replace direct status writes with `updateOrderStatus`. Rider offer acceptance must use `claimRiderOrder`; the current direct ETag claim should be removed after the backend is deployed. FCM handlers must acknowledge these data event types:

- `RESTAURANT_NEW_ORDER`: start the app-owned foreground alarm for `alarmId` until action.
- `STOP_ORDER_ALARM`: stop that exact alarm immediately.
- `RIDER_ORDER_OFFER`: show only to the offered rider until `expiresAt`.
- `REMOVE_RIDER_OFFER`: dismiss the exact order offer.
- `ORDER_STATUS`: refresh the canonical order.

On Android, the four operational restaurant/rider events are deliberately **high-priority data-only messages**. `title` and `body` are included in `data` on the two start events; there is no top-level FCM `notification` and no `android.notification`. Implement them in each native app's `FirebaseMessagingService.onMessageReceived`, persist the exact `orderId` plus `alarmId`/`offerId` before displaying UI, and make START and STOP handling idempotent. Each matching START/STOP pair uses the same collapse key so a queued stale start can be superseded. The app must create its own notification channels and foreground alarm service; FCM priority alone does not bypass Android background-execution, notification-permission, exact-alarm, or foreground-service policies. Ordinary customer `ORDER_STATUS` events retain a visible notification payload.

The Rider app must read only `/feastly/riderJobs/{riderId}` for assignment/order UI, not canonical customer orders. It should upload the current signed-in GPS fix to `/feastly/tracking/{orderId}` with `customerId`, `orderId`, `riderId`, `lat`, `lng`, `accuracy`, `updatedAt`, `status: "live"`, and `phase: "delivery"`. It must not directly write `Near you`, `Arrived`, mirrors, rider-job status, or client-calculated distance evidence; the backend owns those transitions.

## Required RTDB rule additions before client rollout

Rules must deny all client writes to these backend-owned nodes. Device tokens may be written only by their authenticated owner with strict field validation. Do not copy a permissive test rule into production.

```text
/feastly/orderIdempotency       server read/write only
/feastly/private                server read/write only
/feastly/backendEvents          server read/write only
/feastly/paymentAttempts        server read/write only
/feastly/paymentAttemptsByMerchantOrder server read/write only
/feastly/paymentEvents          server read/write only
/feastly/riderWallets           owner/rider scoped read; server write only
/feastly/pricingSignals         authenticated read only if UI needs it; server write only
/feastly/riderAvailabilityByCity server read/write only
/feastly/deviceTokens/{uid}     server read/write only (clients use the callables)
/feastly/restaurantLoad/{restaurantId} authenticated read if needed; server write only
/feastly/tracking/{orderId}      assigned approved rider write with strict immutable IDs/location validation
```

`/feastly/private/deliveryOtps`, `/feastly/private/trackingEvidence`, and `/feastly/private/restaurantWorkload` must not be readable or writable by owner/admin app users; “private” means Admin SDK service accounts only. Delivery OTP records are removed for both `Delivered` and `Cancelled` orders. The current project rules must be checked and migrated before deployment. After clients use the callables, remove direct customer order creation, restaurant workload publication, proximity status changes, and direct status/dispatch writes from the RTDB rules. Remove Rider reads of canonical `/orders`; keep only its own scoped rider-job and active-tracking access. Keep read compatibility for existing customer/restaurant order mirrors during the migration.

## Firebase configuration

Add this exact top-level entry to the existing `firebase.json` (merge it; do not delete current `database` or `storage` entries):

```json
{
  "functions": {
    "source": "functions",
    "runtime": "nodejs22",
    "predeploy": [
      "npm --prefix \"$RESOURCE_DIR\" run typecheck",
      "npm --prefix \"$RESOURCE_DIR\" test",
      "npm --prefix \"$RESOURCE_DIR\" run build"
    ]
  }
}
```

Enable Cloud Functions, Cloud Build, Artifact Registry, Eventarc, Cloud Tasks, FCM and App Check for the production project. Grant the Functions runtime service account only the documented Cloud Tasks enqueuer permission for `dispatchOfferTimeout`. Do not grant Editor.

## PhonePe production adapter prerequisites

No credentials are present in source. Obtain and store the exact production contract values as Firebase/Google Secret Manager secrets, not `.env` or RTDB:

- PhonePe merchant ID/account identifier
- PhonePe client ID and client secret for the contracted API version
- PhonePe webhook authentication material
- production base URL and callback URL allowlisting

The adapter must use PhonePe's current official SDK/API documentation for the merchant account. It must authenticate the webhook, perform a server-to-server status query, compare merchant order ID, amount and currency, enforce replay protection, persist the raw-body hash, and only then call `applyVerifiedPayment`. Refunds require the same independent verification. Until this is built and certified, keep `UnconfiguredPhonePeGateway`; COD is the only usable flow.

## Build and test

```bash
cd functions
npm ci
npm run typecheck
npm test
npm run build
```

For an emulator test, set a disposable Firebase project and start Functions plus Realtime Database. App Check enforcement should be configured with emulator/debug tokens only in non-production environments.

## Deployment sequence

1. Back up the live `/feastly` tree and export current rules.
2. Add deny-by-default backend nodes and scoped token rules.
3. Configure App Check for all four production app IDs.
4. Deploy Functions without switching clients.
5. Run emulator and staging end-to-end tests, including retries, two riders claiming simultaneously, OTP legacy migration, tracking replay/impossible-jump rejection, and Near/Arrived notification delivery.
6. Release compatible app builds that call the backend.
7. Observe logs, FCM delivery, task queue depth and order/mirror reconciliation.
8. Only after adoption, remove legacy client write permissions.

This package is a foundation, not a deployment claim. Production still requires project authentication, approved PhonePe credentials, platform FCM registration, App Check setup, RTDB rule migration, staging tests, monitoring/alerts and Play policy review.
