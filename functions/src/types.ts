export type ActorRole = "customer" | "staff" | "owner" | "ops_admin" | "rider" | "system";

export type OrderStatus =
  | "Order placed"
  | "Accepted"
  | "Preparing"
  | "Ready for pickup"
  | "Assigned"
  | "Handed to rider"
  | "Out for delivery"
  | "Near you"
  | "Arrived"
  | "Delivered"
  | "Cancelled";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Address extends GeoPoint {
  id: string;
  label: string;
  area: string;
  address: string;
  phone: string;
  source: "gps" | "manual";
  updatedAt: number;
  details?: string;
  city?: string;
}

export interface CatalogChoice {
  id?: string;
  name: string;
  price?: number;
  priceDelta?: number;
  available?: boolean;
}

export interface CatalogItem {
  id: string;
  name: string;
  price: number;
  diet?: string;
  available?: boolean;
  archived?: boolean;
  variants?: CatalogChoice[] | Record<string, CatalogChoice>;
  addOns?: CatalogChoice[] | Record<string, CatalogChoice>;
}

export interface CatalogRestaurant extends GeoPoint {
  id: string;
  name: string;
  address: string;
  city?: string;
  open: boolean;
  archived: boolean;
  deliveryFee: number;
  platformFee?: number;
  etaMin: number;
  etaMax: number;
  phone?: string;
  menu?: CatalogItem[] | Record<string, CatalogItem>;
}

export interface CartSelection {
  itemId: string;
  quantity: number;
  variantId?: string;
  addOnIds?: string[];
  note?: string;
}

export interface PricedOrderItem {
  itemId: string;
  name: string;
  quantity: number;
  price: number;
  variant: string;
  variantPrice: number;
  addOns: Array<{name: string; price: number}>;
  addOnTotal: number;
  note: string;
  diet: string;
}

export interface PricingBreakdown {
  subtotal: number;
  discount: number;
  deliveryFee: number;
  smallOrderFee: number;
  lateNightFee: number;
  rainFee: number;
  surgeFee: number;
  platformFee: number;
  tax: number;
  tip: number;
  currency: "INR";
  source: "catalog_snapshot_v3";
}

export interface StatusEvent {
  status: OrderStatus;
  at: number;
  actorId: string;
  actorRole: ActorRole;
  detail?: string;
  reason?: string;
  proof?: string;
}

export interface SavrivoOrder {
  id: string;
  schemaVersion: number;
  idempotencyKey: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  contactProxy?: string;
  restaurantId: string;
  restaurant: string;
  restaurantLocation: {address: string; lat: number; lng: number};
  restaurantPhone?: string;
  items: PricedOrderItem[];
  pricing: PricingBreakdown;
  pricingContext: {
    distanceKm: number;
    platformFeeRule: string;
    weatherSeverity: string;
    surgeActiveOrders: number;
    pricedAt: number;
  };
  total: number;
  coupon: string;
  paymentMethod: "cod" | "upi" | "card";
  paymentProvider?: string;
  paymentState: "cash_due" | "pending" | "authorized" | "paid" | "refunded" | "failed";
  /** Additive server-owned lifecycle projection; legacy `status` remains compatible with all released apps. */
  lifecycleVersion?: 1;
  lifecycleRevision?: number;
  lifecycleUpdatedAt?: number;
  fulfillmentPhase?:
    | "cart" | "payment_pending" | "restaurant_pending" | "restaurant_accepted" | "preparing"
    | "ready_for_pickup" | "picked_up" | "out_for_delivery" | "near_customer" | "arrived_customer" | "delivered";
  dispatchPhase?:
    | "not_started" | "searching" | "assigned" | "arriving_restaurant" | "arrived_restaurant"
    | "picked_up" | "delivering" | "completed";
  paymentPhase?:
    | "not_started" | "pending" | "authorized" | "cash_due" | "paid" | "failed" | "refund_pending" | "refunded";
  terminalPhase?:
    | "none" | "delivered" | "restaurant_rejected" | "customer_cancelled" | "system_cancelled"
    | "delivery_failed" | "payment_failed" | "refunded";
  deliveryMode: "asap" | "scheduled";
  address: Address;
  instructions: string;
  contactless: boolean;
  status: OrderStatus;
  statusHistory: Record<string, StatusEvent>;
  createdAt: number;
  updatedAt: number;
  etaMin: number;
  etaMax: number;
  riderId?: string;
  riderName?: string;
  riderPhone?: string;
  riderAssignedAt?: number;
  deliveredAt?: number;
  cancelReason?: string;
  statusBeforeTerminal?: OrderStatus;
  cancelledByRole?: ActorRole;
  cancellationKind?: "restaurant_rejected" | "customer_cancelled" | "system_cancelled" | "delivery_failed";
}

export interface AuthzDecision {
  role: ActorRole;
  canTransition: boolean;
}

export interface RiderCandidate {
  riderId: string;
  riderName: string;
  distanceKm: number;
  activeLoad: number;
  score: number;
}

export interface DispatchOffer {
  riderId: string;
  offeredAt: number;
  expiresAt: number;
  /** Missing on legacy sequential queue records; treated as wave zero. */
  wave?: number;
}

export interface DispatchPolicySnapshot {
  version: 1;
  mode: "sequential" | "waves";
  initialRadiusKm: number;
  radiusExpansionKm: number;
  maxRadiusKm: number;
  offerTimeoutSeconds: number;
  ridersPerWave: number;
  maxWaves: number;
  maxCandidates: number;
  presenceFreshMs: number;
  maxLocationAccuracyMeters: number;
  reofferCooldownMs: number;
  fairnessLoadPenaltyKm: number;
  claimLeaseSeconds: number;
}

export interface DispatchQueueRecord {
  orderId: string;
  customerId: string;
  restaurantId: string;
  restaurantName: string;
  kitchenStatus?: OrderStatus;
  candidates: RiderCandidate[];
  attempt: number;
  wave?: number;
  currentOffer?: DispatchOffer;
  activeOffers?: Record<string, DispatchOffer>;
  attemptedRiders?: Record<string, number>;
  policySnapshot?: DispatchPolicySnapshot;
  claim?: {
    riderId: string;
    claimedAt: number;
    operationId?: string;
    leaseUntil?: number;
    state?: "reserved" | "order_committed" | "finalized";
  };
  metrics?: {
    offered: number;
    accepted: number;
    rejected: number;
    expired: number;
    startedAt: number;
    assignedAt?: number;
  };
  status: "offering" | "assigned" | "exhausted" | "cancelled";
  createdAt: number;
  updatedAt: number;
}
