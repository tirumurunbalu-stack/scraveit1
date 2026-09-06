# Savrivo product contract

Savrivo is a three-role food-delivery system delivered as separate Android apps over one Firebase-backed operational model:

- **Savrivo** — customer discovery, ordering, support, and live tracking.
- **Savrivo Control** — owner and restaurant-staff operations.
- **Savrivo Rider** — partner onboarding, delivery workflow, navigation, and live location.

The current Firebase project and Android package identifiers remain in place during the developer-build phase so existing authentication configuration continues to work. `feastly` remains only as a legacy internal database namespace until a controlled production migration; it is not customer-facing branding.

## Order lifecycle

Only the following states are valid, in this order:

1. `Order placed` — written by the customer when checkout succeeds.
2. `Accepted` — restaurant owner or permitted staff.
3. `Preparing` — restaurant owner or permitted staff.
4. `Ready for pickup` — restaurant owner or permitted staff.
5. `Assigned` — owner assigns, or an approved rider accepts an eligible delivery.
6. `Handed to rider` — restaurant owner or permitted staff confirms handover.
7. `Out for delivery` — assigned rider after pickup.
8. `Near you` — proximity automation when the rider is within 700 metres.
9. `Arrived` — proximity automation or rider when within 100 metres.
10. `Delivered` — assigned rider after delivery verification.

`Cancelled` is terminal. Customers may request cancellation only before preparation. Owners can cancel with a reason. A refund state is stored separately from fulfilment state.

Every transition must write `status`, `updatedAt`, `statusHistory/{eventId}`, `actorId`, and `actorRole`. Mirrored restaurant order records must be updated atomically with the customer order whenever possible.

## Role contract

| Capability | Customer | Owner | Restaurant staff | Approved rider |
|---|---:|---:|---:|---:|
| Read live catalog | Yes | Yes | Yes | Restaurant context |
| Create an order | Own | No | No | No |
| View order | Own | All | Assigned restaurant | Eligible/assigned |
| Accept / prepare / ready | No | Yes | With `orders` permission | No |
| Assign rider | No | Yes | Optional `dispatch` permission | Self-claim eligible job |
| Confirm handover | No | Yes | With `handover` permission | Acknowledge pickup |
| Update delivery states | No | Override with audit | No | Assigned order only |
| Restaurant/menu CRUD | No | Yes | No | No |
| Promotions/zones/settings | No | Yes | No | No |
| Staff accounts | No | Yes | No | No |
| Rider approval and KYC review | No | Yes | No | Own application |

## Operational data

The production-compatible data contract includes:

- `catalog/restaurants/{restaurantId}` — restaurant identity, location, serviceability, hours, cuisine, hero image, ratings, fees, menu categories and items.
- `users/{uid}` — profile, preferences, selected address, saved addresses, favourites, notification settings and account state.
- `orders/{uid}/{orderId}` — immutable price snapshot, address snapshot, restaurant snapshot, items, payment state, fulfilment state, history, rider assignment and support references.
- `restaurantOrders/{restaurantId}/{uid}/{orderId}` — operational index/mirror used by scoped staff accounts.
- `tracking/{orderId}` — latest rider coordinate, bearing, accuracy, timestamp, phase and sharing state.
- `riders/{uid}` — profile, vehicle, verification state, availability and safe identity metadata.
- `riderDocuments/{uid}` — compressed KYC images, owner/rider access only, retained according to the declared policy.
- `staff/{uid}` — restaurant scope, active flag, granular permissions and audit fields.
- `promotions`, `zones`, `settings`, `reviews`, `support`, `notifications`, and `audit` — owner-managed operational services.

## Product-quality rules

- No screen displays invented success: paid payments, SMS, email deliverability, remote push, and store release remain visibly unavailable until their external accounts are connected.
- Every network action has loading, success, empty, offline and retry states.
- The apps preserve a read-only cache for degraded connectivity and never treat cached order writes as completed server writes.
- Destructive owner actions use explicit confirmation and produce an audit event.
- Personal identity documents are compressed on-device, never logged, never exposed to staff, and are not silently deleted.
- Visible controls meet a 44 dp minimum touch target and text/background contrast is maintained in both light and dark themes.
- Location sharing starts only for an active assigned delivery, remains visible through a foreground notification, and stops when delivery ends.

## External activation gates

The developer builds include integration points but cannot activate these without the relevant owner accounts and credentials:

- production payment gateway and settlement;
- production push-notification sender;
- branded email domain and transactional email authentication;
- Google Play signing/publishing and Apple App Store signing/publishing;
- an iOS toolchain and Apple developer provisioning;
- production observability, crash reporting and service-level monitoring.

