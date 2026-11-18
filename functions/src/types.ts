import type {DeliveryEstimateBasis} from "./domain/deliveryEstimate";
import type {FundingSource, OrderSettlementTerms} from "./domain/economics";

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
  /** House / flat number and floor, as the customer typed it. */
  house?: string;
  landmark?: string;
  /** Street line read from the map pin. */
  street?: string;
  /** Download link to the customer's photo of their gate or building, for the rider. */
  photoUrl?: string;
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
  /** Label details of a pre-packed product (grocery and dairy stores). */
  compliance?: {mrp?: number | string; netQuantity?: string};
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
  /** This restaurant's agreed commission, set by Scraveit (1,500 = 15%). */
  commissionBps?: number;
  /** "markup": menu prices include GST and customers pay them plus markupBps (see domain/markupPricing.ts). Admin only. */
  pricingModel?: string;
  markupBps?: number;
  /** The restaurant's own switch: its menu prices include GST (see domain/markupPricing.ts). */
  pricesIncludeGst?: boolean;
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
  /** GST-inclusive restaurants only (price fields above are then before food GST): one unit as the customer saw it, GST included. */
  listPrice?: number;
  /** GST-inclusive restaurants only: one unit at the restaurant's own price, GST included. */
  restaurantPrice?: number;
  /** A restaurant's free-item offer (domain/freebies.ts): always ₹0, `note` is the offer's title. */
  free?: true;
  freebieId?: string;
}

export interface PricingBreakdown {
  subtotal: number;
  discount: number;
  deliveryFee: number;
  smallOrderFee: number;
  lateNightFee: number;
  rainFee: number;
  surgeFee: number;
  riderIncentiveFee: number;
  /** Charged when most of the city's online riders are already on orders. */
  riderSurgeFee?: number;
  /** Customer-facing name of each part of riderIncentiveFee (e.g. "Late-night fee"). */
  riderIncentiveItems?: {label: string; amount: number}[];
  platformFee: number;
  tax: number;
  tip: number;
  /** Split of `discount` by who pays it. Absent on orders priced before the
   *  economics engine, where the whole discount was restaurant-funded. */
  restaurantDiscount?: number;
  platformDiscount?: number;
  /** Customer wallet money (cashback / referral credit) used; reduces the total. */
  walletRedeem?: number;
  /** GST-inclusive restaurants: the bill as the customer saw it (GST-inclusive food) and, under markup, the restaurant's payout.
   *  subtotal/discount/tax above stay GST-exclusive books. */
  markup?: import("./domain/markupPricing").MarkupBill;
  currency: "INR";
  source: "catalog_snapshot_v3";
}

/** The offer applied to an order, as it stood when the order was priced. */
export interface AppliedOfferSnapshot {
  promotionId: string;
  code: string;
  title: string;
  fundingSource: FundingSource;
  restaurantFundedPaise: number;
  platformFundedPaise: number;
  growthSubsidyPaise: number;
  growthBudgetId: string;
  /** Platform funding the offer asked for that the profitability rule withheld. */
  withheldPlatformPaise: number;
  limitedBy: "" | "profitability" | "growth_budget" | "promotion_budget";
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
  /** The store delivers this order itself; its rider is "store_<restaurantId>". */
  selfDelivery?: boolean;
  items: PricedOrderItem[];
  pricing: PricingBreakdown;
  pricingContext: {
    distanceKm: number;
    /** Road km the delivery fee was charged on (road pricing, 18 Nov 2026). */
    roadKm?: number;
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
  /** Server-computed delivery window, from distance, kitchen load, rider
   *  supply and peak hour - not the restaurant's static catalogue figure. */
  etaMin: number;
  etaMax: number;
  etaConfidence?: "high" | "medium" | "low";
  etaBasis?: DeliveryEstimateBasis;
  riderId?: string;
  riderName?: string;
  riderPhone?: string;
  /** The rider's map avatar preset, copied from their profile at assignment. */
  riderAvatar?: string;
  /** Set when a parent pays for their child's order; they may start its online payment. */
  payerUid?: string;
  /** Multi-restaurant ("cluster") orders: one cart split into one order per restaurant. */
  clusterId?: string;
  clusterIndex?: number;
  clusterSize?: number;
  /** Set while the other restaurants' parts are still being created: no restaurant sees it yet. */
  clusterHold?: boolean;
  /** When the kitchen should start, so every part of the cluster arrives together. */
  kitchenStartAt?: number;
  /** Multi-restaurant parts one rider collects in one trip (see domain/clusterPlan): pickup order. */
  clusterTrip?: ClusterTripLink;
  /** Two customers' orders one rider carries together (see domain/orderBatch). */
  batch?: OrderBatchLink;
  /** The customer tapped this store's Ad (top placement) at this time, in the 24 hours before ordering. */
  adClickAt?: number;
  /** Squad orders: the squad's code and everyone who put picks in (host included). */
  squadCode?: string;
  squadMemberUids?: string[];
  squadMembers?: Array<{uid: string; name: string; subtotal: number}>;
  /** When the rider is expected at the restaurant (estimated at assignment). */
  riderPickupEtaAt?: number;
  /** Shown on the customer's rider card: average rating (once rated) and
   *  delivered orders, copied from the rider profile at assignment. */
  riderRating?: number;
  riderDeliveredCount?: number;
  riderAssignedAt?: number;
  deliveredAt?: number;
  cancelReason?: string;
  statusBeforeTerminal?: OrderStatus;
  cancelledByRole?: ActorRole;
  cancellationKind?: "restaurant_rejected" | "customer_cancelled" | "system_cancelled" | "delivery_failed";
  /** Settlement terms frozen at checkout. Settlement reads these, never
   *  today's configuration, so later rule changes cannot alter them. The full
   *  snapshot (Scraveit's margin and reserves) is in `orderEconomics/{id}`. */
  economics?: OrderSettlementTerms;
  appliedOffer?: AppliedOfferSnapshot;
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
  /** Rider is Online but their phone stopped reporting: a backup after every live rider. */
  staleSignal?: boolean;
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
  /** Two-order batching (domain/orderBatch); missing means on. */
  batchingEnabled?: boolean;
}

export interface ClusterTripLink {
  clusterId: string;
  /** Orders this rider collects, in pickup order; the first is the trip's lead. */
  orderIds: string[];
  leadOrderId: string;
  /** This order's place in the pickup order (0 = lead). */
  stop: number;
}

/**
 * Two orders from different customers carried by one rider: both kitchens first, then the doors,
 * the earlier-placed order delivered first.
 */
export interface OrderBatchLink {
  id: string;
  /** The two orders, in the order they were placed. */
  orderIds: string[];
  /** The order the rider already had when the second joined. */
  leadOrderId: string;
  /** Kitchens in collection order (order ids). */
  pickupOrder: string[];
  /** Doors in delivery order (order ids): the earlier-placed order first. */
  dropOrder: string[];
  /** This order's place in the delivery order (1 = delivered first). */
  position: number;
  size: number;
  /** How much later the lead customer gets their food because of the second order. */
  leadExtraMinutes: number;
  createdAt: number;
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
  /** Riders who said no to this order; a missed offer can come back, a refusal doesn't. */
  declinedRiders?: Record<string, number>;
  /** Riders last considered on an old signal, kept when a later scan replaces the candidate list. */
  backupRiders?: string[];
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
  /** A later pickup of a shared multi-restaurant trip, offered only to the lead order's rider. */
  bundle?: {
    leadOrderId: string;
    riderId: string;
    stop: number;
    stops: number;
    /** "batch": a second customer's order added to the rider's current trip (domain/orderBatch). */
    kind?: "trip" | "batch";
    pickupOrder?: string[];
    dropOrder?: string[];
    leadExtraMinutes?: number;
  };
  /** On a trip's lead order: how many restaurants the rider collects in this trip. */
  tripPickups?: number;
  /** The trip's rider was already offered this pickup (declined or let it expire): any rider now. */
  bundleTried?: boolean;
  createdAt: number;
  updatedAt: number;
}
