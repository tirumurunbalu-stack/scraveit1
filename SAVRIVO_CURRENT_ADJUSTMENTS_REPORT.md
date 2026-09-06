# Savrivo Current Adjustments — 20 Aug 2026

This patch is based on the previously fixed Savrivo Operational Upgrade source and implements the issue/feature batch discussed after APK testing.

## Shared UI across all 4 apps
- Bottom navigation is forced to stay fixed while page content scrolls.
- Safe-bottom handling uses Android/WebView safe-area values for gesture/button navigation layouts.
- Horizontal page/sheet drift is blocked globally.
- Inputs, images, forms and sheets are constrained to the viewport.
- Existing sessions use a neutral launch/loading screen instead of briefly rendering login first.

## Customer
- View Cart bar is fixed immediately above the bottom navigation.
- Restaurant/customisation sheets are protected from horizontal scrolling.
- Home promotional area supports local area/city sponsored campaigns managed by Admin.
- Local ads can contain a compressed image, title, message, CTA, city/area scope, time range and restaurant destination.
- Active order card remains the main entry to order details/live journey.
- A delivered order with no review becomes a Home feedback card until feedback is submitted.
- Feedback supports restaurant rating and rider rating separately.
- UI includes optional post-delivery tip and optional Help Savrivo Grow amount. In this developer build these amounts are recorded with feedback; actual money collection/settlement still requires a payment backend.
- Savrivo Assistant is text-only and provides first-line contextual support before escalation.
- Escalation creates an Admin service request with order context, assistant summary, transcript, priority and unseen state.
- Customer reads Admin-created scheduled notifications with emoji support and audience targeting.
- While the Customer app process is active, future notifications are timed locally for their selected schedule. Reliable push when the app has never received the schedule / is fully stopped requires FCM plus a trusted backend.
- Platform fee resolution now supports area/zone overrides.
- Distance delivery fee resolution now supports restaurant, area and city slab overrides.

## Restaurant
- New unhandled orders trigger a persistent native notification and looping alert sound while the app process is active.
- The alert stops only after all `Order placed` items are handled.
- Restaurant can Accept or Decline a new order.
- Decline requires a reason and can include a note; customer/mirror order is updated to Cancelled.
- Existing session opens through a launch state rather than flashing login.
- Development screenshots remain enabled.

## Admin
- Pricing & Fees now visibly includes global defaults and scoped overrides.
- Platform fee supports city, area/zone, category, restaurant and order-value overrides.
- Delivery fee slabs support city, area/zone and restaurant-specific overrides.
- Order detail adds Restaurant contact, restaurant ID, address and call/open actions in addition to customer/rider details.
- Customer Notifications screen supports emoji title/message, all/city/area/restaurant audiences, selected date/time, expiry and destination.
- Local Ads screen supports area/city targeting, schedule, priority, restaurant destination and compressed image upload.
- Support queue now has Open Request. Opening records `seenAt`, moves a new ticket to In Progress and stops the unseen alert for that ticket.
- AI-assisted escalations display summary and transcript to Admin.
- New unseen service requests trigger a persistent native notification and looping alert sound while the Admin app process is active.
- Development screenshots remain enabled.

## Partner
- Existing operational upgrade features remain: no forced email verification, persistent onboarding draft, private chats, tip-aware earnings and handover privacy.
- Session restoration now uses a launch screen instead of flashing login.
- Shared fixed-navigation and horizontal-overflow fixes apply.

## Firebase rules
- Replaces the Firebase-undeterminizable chat phone regex with a simple explicit 10-digit guard.
- Adds area platform-fee overrides.
- Adds scoped delivery-fee overrides.
- Adds local ads and customer broadcast trees.
- Adds AI support fields (`aiSummary`, `assistantTranscript`, `priority`, `seenAt`).
- Allows restaurant cancellation/decline workflow.
- Adds optional rider feedback/post-delivery tip/growth contribution fields to review records.

## Validation completed here
- All four `premium.js` files pass Node syntax checks.
- Realtime Database rules parse as JSON.
- Project validation passes **326 assertions across 4 apps**.

## Must still be validated on the Mac
This environment does not have the Firebase CLI or Android SDK, so run:

```bash
./BUILD_ON_MAC.sh --deploy
```

This performs the Firebase rules dry-run/deploy and builds all four APKs using the Mac Android SDK.

## Production reminders
1. Admin + Restaurant screenshot blocking (`FLAG_SECURE`) is intentionally disabled only during development. Restore it for final APK/AAB release even if not requested again.
2. Truly reliable new-order/support/customer push notifications while an app process is killed require FCM/trusted backend delivery. The current persistent alert is native once the app receives the event.
3. Savrivo Assistant in this build is a contextual first-line assistant, not a remotely hosted LLM. A real AI model should be called from a trusted backend, never by embedding a secret API key in the APK.
4. Post-delivery monetary tip/growth contribution requires payment collection and settlement integration before it can represent real money.
