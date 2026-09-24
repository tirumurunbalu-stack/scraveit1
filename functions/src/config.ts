export const REGION = "asia-south1";
// Realtime Database triggers must be deployed in the database instance's
// location. RTDB itself has no India region at all - `riderPresence` and
// `tracking` (the only paths still on RTDB; everything else moved to
// Firestore in asia-south1/Mumbai) live on a dedicated non-default instance
// in asia-southeast1 (Singapore), the closest RTDB region actually offers to
// India, instead of the project's original default instance in us-central1.
export const DATABASE_REGION = "asia-southeast1";
export const DATABASE_INSTANCE = "savrivo-app-sg";
export const ROOT = "feastly";
// Keep version 3 until every installed client and the deployed RTDB rules have
// completed the coordinated schema migration. Server authority is recorded in
// pricingContext without breaking existing order readers.
export const SCHEMA_VERSION = 3;
export const PRESENCE_FRESH_MS = 90_000;
// A restaurant-ready offer stays stable long enough for a rider to read and
// act even on a slower handset/network. The queue still advances atomically.
// Allow enough time to review route/payout and act on slower mobile networks. The server still
// atomically assigns the first valid claimant, so this does not weaken concurrency protection.
export const RIDER_OFFER_SECONDS = 180;
// Delivery offers use a validated GPS straight-line estimate. Coordinates
// beyond this service radius are rejected instead of displaying absurd values.
export const MAX_DISPATCH_RADIUS_KM = 50;
export const MAX_DISPATCH_ACCURACY_METERS = 100;
// Do not repeatedly offer the same unclaimed order to the same rider while
// presence heartbeats recover an exhausted queue.
export const RIDER_REOFFER_COOLDOWN_MS = 5 * 60_000;
// Presence arrives every few seconds. Allow one platform-wide exhausted-queue
// recovery scan per interval so an online rider can receive a missed order
// again after its re-offer cooldown, without scanning once per heartbeat/rider.
export const DISPATCH_RECOVERY_SCAN_INTERVAL_MS = 30_000;
export const MAX_RIDER_CANDIDATES = 20;
export const MAX_CART_LINES = 50;
export const MAX_ITEMS_PER_LINE = 20;
export const MAX_DEVICE_TOKENS_PER_USER = 20;

export const pathFor = {
  order: (customerId: string, orderId: string) =>
    `${ROOT}/orders/${customerId}/${orderId}`,
  restaurantOrder: (restaurantId: string, customerId: string, orderId: string) =>
    `${ROOT}/restaurantOrders/${restaurantId}/${customerId}/${orderId}`,
  menu: (restaurantId: string) => `${ROOT}/menus/${restaurantId}`,
  restaurant: (restaurantId: string) => `${ROOT}/catalog/restaurants/${restaurantId}`,
  user: (uid: string) => `${ROOT}/users/${uid}`,
  dispatch: (orderId: string) => `${ROOT}/dispatchQueue/${orderId}`,
} as const;
