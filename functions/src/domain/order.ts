import {createHash} from "node:crypto";
import type {
  ActorRole,
  CatalogChoice,
  CatalogItem,
  CartSelection,
  GeoPoint,
  OrderStatus,
  PricedOrderItem,
  PricingBreakdown,
  RiderCandidate,
  SavrivoOrder,
  StatusEvent,
} from "../types";
import {
  buildLifecycleMutation,
  deriveLifecycle,
  deriveLifecycleFromCanonicalState,
} from "./lifecycle";
import {beforeFoodGstPaise, markedUpPrice, type MarkupCart} from "./markupPricing";
import {freebieLines} from "./freebies";
import {cancelCause} from "./partnerCancelPay";
import {isAfterPickupStatus} from "./afterPickup";

export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  "Order placed": ["Accepted", "Cancelled"],
  "Accepted": ["Preparing", "Cancelled"],
  "Preparing": ["Ready for pickup", "Cancelled"],
  "Ready for pickup": ["Assigned", "Cancelled"],
  "Assigned": ["Handed to rider", "Cancelled"],
  // After pickup only Scraveit's admin (with an after-pickup reason, orders.ts) or the customer
  // themselves, with the 100% cancellation fee (canTransition), may cancel.
  "Handed to rider": ["Out for delivery", "Cancelled"],
  "Out for delivery": ["Near you", "Arrived", "Cancelled"],
  "Near you": ["Arrived", "Cancelled"],
  "Arrived": ["Delivered", "Cancelled"],
  "Delivered": [],
  "Cancelled": [],
};

const ROLE_TARGETS: Readonly<Record<ActorRole, readonly OrderStatus[]>> = {
  customer: ["Cancelled"],
  staff: ["Accepted", "Preparing", "Ready for pickup", "Handed to rider", "Cancelled"],
  owner: ["Accepted", "Preparing", "Ready for pickup", "Handed to rider", "Cancelled"],
  ops_admin: ["Accepted", "Preparing", "Ready for pickup", "Handed to rider", "Cancelled"],
  // Proximity states are backend-geofence only. A rider may confirm pickup and
  // complete delivery, but cannot self-report Near/Arrived through the public
  // status callable. "Handed to rider" only with the parcel photo (services/orders.ts).
  rider: ["Assigned", "Handed to rider", "Out for delivery", "Delivered"],
  // "Ready for pickup" only when the rider photographs the parcel before the
  // kitchen tapped Order ready (services/orders.ts).
  system: ["Assigned", "Ready for pickup", "Near you", "Arrived", "Cancelled"],
};

export function canTransition(from: OrderStatus, to: OrderStatus, role: ActorRole): boolean {
  if (!TRANSITIONS[from].includes(to) || !ROLE_TARGETS[role].includes(to)) return false;
  // The food is with the delivery partner: the restaurant and automatic cancels can't cancel any
  // more. Scraveit's admin can, and so can the customer, with the 100% cancellation fee they
  // accepted in the app (founder 22 Nov 2026; services/orders.ts cancelOrderByCustomer).
  if (to === "Cancelled" && isAfterPickupStatus(from)) return role === "owner" || role === "ops_admin" || role === "customer";
  return true;
}

export interface OrderTransitionMutation {
  toStatus: OrderStatus;
  actorRole: ActorRole;
  eventId: string;
  event: StatusEvent;
  now: number;
  reason?: string;
  expectedRiderId?: string;
  /** The customer's accepted 100% cancellation fee, stamped on the cancelled order. */
  cancellationFee?: SavrivoOrder["cancellationFee"];
}

/**
 * Who a cancel is counted against in reports. "owner" is Scraveit's own admin
 * (the restaurant's people cancel as "staff"), so an admin cancel follows the
 * reason picked: before 21 Nov 2026 every admin cancel, even "Customer
 * cancellation approved", was counted as the restaurant rejecting the order.
 */
export function cancellationKindFor(
  role: ActorRole,
  reason?: string,
): "customer_cancelled" | "restaurant_rejected" | "system_cancelled" {
  const cause = cancelCause({cancelledByRole: role, cancelReason: reason});
  return cause === "customer" ? "customer_cancelled" : cause === "restaurant" ? "restaurant_rejected" : "system_cancelled";
}

/**
 * Builds the next canonical order value for an RTDB transaction.
 *
 * Realtime Database may invoke a transaction updater once with a local null
 * value before it has downloaded the server value. The caller therefore passes
 * its immediately preceding canonical read as `cached`. Firebase will rerun the
 * updater with the authoritative server value before committing whenever that
 * value differs. Canonical orders are immutable records and are never hard
 * deleted, so using that read for the provisional pass cannot resurrect a
 * legitimately deleted order.
 */
export function buildOrderTransitionCandidate(
  current: SavrivoOrder | null,
  cached: SavrivoOrder,
  mutation: OrderTransitionMutation,
): SavrivoOrder | undefined {
  const source = current ?? cached;
  if (source.id !== cached.id || source.customerId !== cached.customerId ||
    source.restaurantId !== cached.restaurantId || source.createdAt !== cached.createdAt ||
    source.status !== cached.status || !canTransition(source.status, mutation.toStatus, mutation.actorRole) ||
    (mutation.expectedRiderId && source.riderId !== mutation.expectedRiderId)) return undefined;
  const terminalMetadata = mutation.toStatus === "Cancelled" ? {
    statusBeforeTerminal: source.status,
    cancelledByRole: mutation.actorRole,
    cancellationKind: cancellationKindFor(mutation.actorRole, mutation.reason),
    ...(mutation.cancellationFee ? {cancellationFee: mutation.cancellationFee} : {}),
  } : {};
  const candidate: SavrivoOrder = {
    ...source,
    status: mutation.toStatus,
    ...(mutation.toStatus === "Delivered" && source.paymentMethod === "cod" ? {paymentState: "paid" as const} : {}),
    updatedAt: mutation.now,
    statusHistory: {...(source.statusHistory ?? {}), [mutation.eventId]: mutation.event},
    ...(mutation.reason ? {cancelReason: mutation.reason} : {}),
    ...(mutation.toStatus === "Delivered" ? {deliveredAt: mutation.now} : {}),
    ...terminalMetadata,
  };
  const lifecycle = buildLifecycleMutation(
    deriveLifecycle(source),
    deriveLifecycleFromCanonicalState(candidate),
    mutation.now,
  );
  return {...candidate, ...lifecycle.patch};
}

/**
 * A 15-digit order number that never starts with 0 (Swiggy's format): staff
 * and riders read it out and match its last 4 digits at pickup. 15 digits
 * still fit exactly in a JavaScript number and in an Excel cell. The same
 * customer and checkout key always give the same number, so a retried
 * checkout finds its order; `attempt` picks the next number if another
 * order already holds this one.
 */
export function deterministicOrderId(customerId: string, idempotencyKey: string, attempt = 0): string {
  const hex = createHash("sha256").update(`${customerId}:${idempotencyKey}${attempt ? `:${attempt}` : ""}`).digest("hex");
  return String(BigInt(`0x${hex.slice(0, 16)}`) % 900_000_000_000_000n + 100_000_000_000_000n);
}

/** The id orders had before 15-digit numbers ("SV-" and 18 hex characters). */
export function legacyOrderId(customerId: string, idempotencyKey: string): string {
  return `SV-${createHash("sha256").update(`${customerId}:${idempotencyKey}`).digest("hex").slice(0, 18).toUpperCase()}`;
}

export function hashOtp(otp: string, salt: string): string {
  return createHash("sha256").update(`${otp}${salt}`).digest("hex");
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const earthKm = 6371;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * sinLng * sinLng;
  return earthKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function choices(value: CatalogItem["variants"] | CatalogItem["addOns"]): CatalogChoice[] {
  if (Array.isArray(value)) return value;
  return Object.entries(value ?? {}).map(([id, choice]) => ({id, ...choice}));
}

function choicePrice(choice: CatalogChoice): number {
  const value = choice.priceDelta ?? choice.price ?? 0;
  if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_CATALOG_PRICE");
  return roundMoney(value);
}

function findChoice(all: CatalogChoice[], id: string | undefined, required: boolean): CatalogChoice | undefined {
  if (!id) {
    if (required && all.length) throw new Error("VARIANT_REQUIRED");
    return undefined;
  }
  const normalized = id.trim().toLowerCase();
  const found = all.find((entry) => entry.id === id || entry.name.trim().toLowerCase() === normalized);
  if (!found || found.available === false) throw new Error("CUSTOMIZATION_UNAVAILABLE");
  return found;
}

/**
 * Prices a cart from the menu. With `markupBps` (a markup restaurant) or
 * `gstInclusive` (see domain/markupPricing.ts) menu prices are the restaurant's
 * GST-inclusive prices: under markup each part is raised to the customer's
 * price, and the item is priced at that price's value before the 5% food GST,
 * so the order's books stay GST-exclusive. `markup` then carries the totals the
 * customer and the restaurant saw.
 */
export function priceCart(
  selections: CartSelection[],
  menuById: Record<string, CatalogItem>,
  options: {markupBps?: number | null; gstInclusive?: boolean; freebies?: unknown} = {},
): {items: PricedOrderItem[]; subtotal: number; markup?: MarkupCart} {
  const markupBps = options.markupBps ?? null;
  const inclusive = markupBps === null && options.gstInclusive === true;
  const bps = inclusive ? 0 : markupBps;
  // A restaurant price -> the customer's price, GST included -> its value before GST.
  const list = (price: number) => bps === null || inclusive ? price : markedUpPrice(price, bps);
  const book = (price: number) => bps === null ? price : beforeFoodGstPaise(Math.round(list(price) * 100)) / 100;
  let listSubtotal = 0, restaurantSubtotal = 0;
  const items = selections.map((selection) => {
    const item = menuById[selection.itemId];
    if (!item || item.archived === true || item.available === false) throw new Error("ITEM_UNAVAILABLE");
    if (!Number.isFinite(item.price) || item.price < 0) throw new Error("INVALID_CATALOG_PRICE");

    const variant = findChoice(choices(item.variants), selection.variantId, choices(item.variants).length > 0);
    const availableAddOns = choices(item.addOns);
    const selectedAddOns = (selection.addOnIds ?? []).map((id) => findChoice(availableAddOns, id, false));
    if (new Set(selection.addOnIds ?? []).size !== (selection.addOnIds ?? []).length) {
      throw new Error("DUPLICATE_ADD_ON");
    }
    const chosenAddOns = selectedAddOns.filter((value): value is CatalogChoice => value !== undefined);
    const addOns = chosenAddOns.map((entry) => ({name: entry.name, price: roundMoney(book(choicePrice(entry)))}));
    const ownVariantPrice = variant ? choicePrice(variant) : 0;
    const variantPrice = roundMoney(book(ownVariantPrice));
    // A pre-packed product is never sold above the MRP printed on it (Legal
    // Metrology (Packaged Commodities) Rules, 2011, rule 18). Delivery,
    // platform and maintenance fees are Scraveit's own charges, billed apart.
    const mrp = Number(item.compliance?.mrp);
    if (Number.isFinite(mrp) && mrp > 0 && roundMoney(list(item.price) + list(ownVariantPrice)) > roundMoney(mrp)) {
      throw new Error("PRICE_ABOVE_MRP");
    }
    const addOnTotal = roundMoney(addOns.reduce((sum, entry) => sum + entry.price, 0));
    const markup = bps === null ? {} : (() => {
      const own = [item.price, ownVariantPrice, ...chosenAddOns.map(choicePrice)];
      const listPrice = own.reduce((sum, price) => sum + list(price), 0);
      const restaurantPrice = roundMoney(own.reduce((sum, price) => sum + price, 0));
      listSubtotal += listPrice * selection.quantity;
      restaurantSubtotal += restaurantPrice * selection.quantity;
      return {listPrice, restaurantPrice};
    })();

    return {
      itemId: item.id,
      name: item.name,
      quantity: selection.quantity,
      price: roundMoney(book(item.price)),
      variant: variant?.name ?? "",
      variantPrice,
      addOns,
      addOnTotal,
      note: selection.note?.slice(0, 200) ?? "",
      diet: item.diet?.slice(0, 30) ?? "",
      ...markup,
    };
  });

  const subtotal = roundMoney(items.reduce((sum, item) =>
    sum + (item.price + item.variantPrice + item.addOnTotal) * item.quantity, 0));
  if (subtotal <= 0) throw new Error("EMPTY_OR_FREE_ORDER");
  // The restaurant's free items ride along at ₹0; the item total the customer saw decides "above ₹X".
  items.push(...freebieLines(options.freebies, items, bps === null ? subtotal : roundMoney(listSubtotal)));
  if (bps === null) return {items, subtotal};
  return {items, subtotal, markup: {...(inclusive ? {model: "inclusive" as const} : {}), bps,
    listSubtotal: roundMoney(listSubtotal), restaurantSubtotal: roundMoney(restaurantSubtotal)}};
}

export interface FeeInput {
  subtotal: number;
  discount: number;
  deliveryFee: number;
  platformFee: number;
  taxRate: number;
  tip: number;
  smallOrderThreshold?: number;
  smallOrderFee?: number;
  lateNightFee?: number;
  rainFee?: number;
  surgeFee?: number;
  riderIncentiveFee?: number;
  riderSurgeFee?: number;
  /** Wallet money applied: a way of paying, not a discount, so tax is unaffected. */
  walletRedeem?: number;
  /** Tax computed by CA-defined component rules; replaces taxRate when present. */
  taxOverride?: number;
}

export function buildPricing(input: FeeInput): {pricing: PricingBreakdown; total: number} {
  const taxable = Math.max(0, input.subtotal - input.discount);
  const pricing: PricingBreakdown = {
    subtotal: roundMoney(input.subtotal),
    discount: roundMoney(input.discount),
    deliveryFee: roundMoney(Math.max(0, input.deliveryFee)),
    smallOrderFee: roundMoney(
      input.smallOrderThreshold && input.subtotal < input.smallOrderThreshold ? Math.max(0, input.smallOrderFee ?? 0) : 0,
    ),
    lateNightFee: roundMoney(Math.max(0, input.lateNightFee ?? 0)),
    rainFee: roundMoney(Math.max(0, input.rainFee ?? 0)),
    surgeFee: roundMoney(Math.max(0, input.surgeFee ?? 0)),
    riderIncentiveFee: roundMoney(Math.max(0, input.riderIncentiveFee ?? 0)),
    ...((input.riderSurgeFee ?? 0) > 0 ? {riderSurgeFee: roundMoney(input.riderSurgeFee ?? 0)} : {}),
    platformFee: roundMoney(Math.max(0, input.platformFee)),
    tax: input.taxOverride !== undefined ? roundMoney(Math.max(0, input.taxOverride)) :
      roundMoney(taxable * Math.max(0, input.taxRate) / 100),
    tip: roundMoney(Math.max(0, input.tip)),
    ...(input.walletRedeem && input.walletRedeem > 0 ? {walletRedeem: roundMoney(input.walletRedeem)} : {}),
    currency: "INR",
    source: "catalog_snapshot_v3",
  };
  const total = roundMoney(
    pricing.subtotal - pricing.discount + pricing.deliveryFee + pricing.smallOrderFee +
    pricing.lateNightFee + pricing.rainFee + pricing.surgeFee + pricing.riderIncentiveFee + (pricing.riderSurgeFee ?? 0) +
    pricing.platformFee + pricing.tax + pricing.tip - (pricing.walletRedeem ?? 0),
  );
  return {pricing, total};
}

export function rankRiders(candidates: Omit<RiderCandidate, "score">[]): RiderCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    score: roundMoney(candidate.distanceKm + candidate.activeLoad * 5),
  })).sort((a, b) => a.score - b.score || a.distanceKm - b.distanceKm || a.riderId.localeCompare(b.riderId));
}
