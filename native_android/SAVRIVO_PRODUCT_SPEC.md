# Savrivo product contract — 4-app architecture

Savrivo is a four-app food-delivery system sharing one Firebase-backed operational model:

- **Savrivo Customer** — customer discovery, ordering, addresses, support and tracking.
- **Savrivo Admin** — platform-owner administration, approvals, overrides, riders, settings and audit.
- **Savrivo Restaurant** — restaurant owner/manager/staff menu, availability and order operations for assigned restaurants only.
- **Savrivo Partner** — rider onboarding, availability, delivery offers, navigation and foreground location sharing.

The legacy internal Firebase namespace `feastly` is deliberately retained during migration so existing authentication/data paths are not destroyed. Customer-facing branding is Savrivo.

## Responsibility split

### Admin

Admin is platform control, not a restaurant daily-operations app. It can approve/suspend restaurants and riders, provision restaurant accounts, set platform configuration and perform audited overrides.

### Restaurant

Savrivo staff can perform the initial restaurant setup. After verification, Restaurant users maintain their own menu, item availability, photos, preparation data, restaurant profile and online/offline status. Access is scoped to assigned restaurant IDs and permissions.

Restaurant roles are:

- `restaurant_owner`
- `restaurant_manager`
- `restaurant_staff`

Granular staff permissions include `orders`, `handover`, `tracking`, `dispatch`, `menu`, `availability`, `profile`, and `analytics`.

### Customer

Customer receives live restaurant/menu/order/tracking updates through scoped Firebase streams with slow polling only as a resilience fallback. Delivery addresses support a tappable OSM pin plus native current-location detection.

### Partner

Partner receives delivery data through realtime streams, stores KYC images in Firebase Storage rather than RTDB Base64, and uses a native Android foreground service for active-delivery GPS. Fresh offer claiming begins with an ETag conditional write to reduce double-claim races; a trusted backend transaction remains the production target.

## Order lifecycle

Valid fulfilment states are:

1. `Order placed`
2. `Accepted`
3. `Preparing`
4. `Ready for pickup`
5. `Assigned`
6. `Handed to rider`
7. `Out for delivery`
8. `Near you`
9. `Arrived`
10. `Delivered`

`Cancelled` is terminal. Status updates must update the canonical customer order and restaurant operational mirror together whenever possible and append a status-history event.

## Data model during migration

Existing compatible paths remain available:

- `catalog/restaurants/{restaurantId}` — restaurant profile and legacy embedded menu.
- `menus/{restaurantId}/{itemId}` — normalized menu records; new Restaurant writes use this path.
- `users/{uid}` — customer profile/preferences/addresses.
- `orders/{uid}/{orderId}` — canonical customer order record.
- `restaurantOrders/{restaurantId}/{uid}/{orderId}` — restaurant-scoped operational mirror.
- `staff/{uid}` — Restaurant account scope, role and permissions.
- `restaurantMembers/{restaurantId}/{uid}` and `userRestaurants/{uid}/{restaurantId}` — additive membership indexes.
- `restaurantStaffInvites/{restaurantId}/{inviteId}` — Restaurant account requests awaiting Admin provisioning.
- `dispatchQueue/{orderId}` — current delivery-offer queue.
- `riderJobs/{uid}/{orderId}` — rider-scoped job pointers.
- `tracking/{orderId}` — latest active-delivery location.
- `riderDocuments/{uid}` — **Storage URLs only for new KYC submissions**.

Admin dual-writes menu changes to legacy + normalized menu structures during the compatibility period. Restaurant can seed normalized menus from an assigned legacy menu when permitted.

## Media/storage rules

Large images do not belong in Realtime Database.

- Restaurant/menu media → Firebase Storage, RTDB stores URL/metadata.
- Rider KYC → private Firebase Storage, RTDB stores URL/metadata.
- Base64 remains accepted only where needed for legacy data compatibility; new production writes should use Storage.

## Security contract

- UI hiding is not authorization.
- Admin access is platform-owner/ops-admin only.
- Restaurant users can only operate assigned restaurants and granted permissions.
- Riders can only manipulate their own approved delivery data.
- Customers can only manipulate their own account/order data.
- Price/payment trust must move to a backend before real online payments.
- KYC must not be public.
- Firebase rules and backend transitions must be emulator/integration tested before production deployment.

## External activation gates

The Android repository cannot by itself activate services that require owner accounts/credentials. These remain explicit production gates:

- payment gateway + webhook verification/refunds/settlement;
- trusted server-side order/pricing calculation;
- production push notification sender;
- branded transactional email;
- production crash/ANR/observability stack;
- Play/App Store signing and publishing;
- iOS implementation/provisioning;
- live Firebase rule/storage deployment and billing controls.
