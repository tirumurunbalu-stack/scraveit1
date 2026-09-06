# Feastly

A cross-platform food delivery application built with Flutter. It runs from one codebase on Android and iOS and includes customer ordering, delivery-partner operations, and restaurant controls.

## Included demo workflows

- Browse restaurants and menus, search dishes, add items to cart, apply an offer, and place a cash-on-delivery or online-payment demo order.
- Track active orders, view order history, and rate a completed order.
- Switch into **Rider** mode to accept a delivery, update delivery steps, and view earnings.
- Switch into **Restaurant** mode to accept/prepare orders, toggle menu availability, and view sales.
- All demo data is stored on-device during the session; paid services are deliberately not required.

## Run it

1. Install the free [Flutter SDK](https://docs.flutter.dev/get-started/install) and Xcode / Android Studio as appropriate.
2. From this folder run `flutter create --platforms=android,ios .` once. This generates the free platform wrapper files without changing the app source.
3. Run `flutter pub get` and then `flutter run`.

## Production integrations left configurable

The screens and app flows are ready. Before a public launch, connect the integration points to accounts owned by the client:

- Payment gateway (Razorpay / Stripe)
- Maps and turn-by-turn navigation
- OTP provider and push notifications
- Hosted API/database and file storage
- Apple Developer and Google Play publishing accounts

Keeping those accounts in the client’s name avoids vendor lock-in and ensures the client owns the business data.
