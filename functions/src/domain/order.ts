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

export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  "Order placed": ["Accepted", "Cancelled"],
  "Accepted": ["Preparing", "Cancelled"],
  "Preparing": ["Ready for pickup", "Cancelled"],
  "Ready for pickup": ["Assigned", "Cancelled"],
  "Assigned": ["Handed to rider", "Cancelled"],
  "Handed to rider": ["Out for delivery"],
  "Out for delivery": ["Near you", "Arrived"],
  "Near you": ["Arrived"],
  "Arrived": ["Delivered"],
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
  // status callable.
  rider: ["Assigned", "Out for delivery", "Delivered"],
  system: ["Assigned", "Near you", "Arrived", "Cancelled"],
};

export function canTransition(from: OrderStatus, to: OrderStatus, role: ActorRole): boolean {
  return TRANSITIONS[from].includes(to) && ROLE_TARGETS[role].includes(to);
}

export interface OrderTransitionMutation {
  toStatus: OrderStatus;
  actorRole: ActorRole;
  eventId: string;
  event: StatusEvent;
  now: number;
  reason?: string;
  expectedRiderId?: string;
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
    cancellationKind: mutation.actorRole === "customer" ? "customer_cancelled" as const :
      mutation.actorRole === "staff" || mutation.actorRole === "owner" ? "restaurant_rejected" as const :
        "system_cancelled" as const,
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

export function deterministicOrderId(customerId: string, idempotencyKey: string): string {
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

export function priceCart(
  selections: CartSelection[],
  menuById: Record<string, CatalogItem>,
): {items: PricedOrderItem[]; subtotal: number} {
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
    const addOns = selectedAddOns.filter((value): value is CatalogChoice => value !== undefined)
      .map((entry) => ({name: entry.name, price: choicePrice(entry)}));
    const variantPrice = variant ? choicePrice(variant) : 0;
    const addOnTotal = roundMoney(addOns.reduce((sum, entry) => sum + entry.price, 0));

    return {
      itemId: item.id,
      name: item.name,
      quantity: selection.quantity,
      price: roundMoney(item.price),
      variant: variant?.name ?? "",
      variantPrice,
      addOns,
      addOnTotal,
      note: selection.note?.slice(0, 200) ?? "",
      diet: item.diet?.slice(0, 30) ?? "",
    };
  });

  const subtotal = roundMoney(items.reduce((sum, item) =>
    sum + (item.price + item.variantPrice + item.addOnTotal) * item.quantity, 0));
  if (subtotal <= 0) throw new Error("EMPTY_OR_FREE_ORDER");
  return {items, subtotal};
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
    platformFee: roundMoney(Math.max(0, input.platformFee)),
    tax: roundMoney(taxable * Math.max(0, input.taxRate) / 100),
    tip: roundMoney(Math.max(0, input.tip)),
    currency: "INR",
    source: "catalog_snapshot_v3",
  };
  const total = roundMoney(
    pricing.subtotal - pricing.discount + pricing.deliveryFee + pricing.smallOrderFee +
    pricing.lateNightFee + pricing.rainFee + pricing.surgeFee + pricing.riderIncentiveFee +
    pricing.platformFee + pricing.tax + pricing.tip,
  );
  return {pricing, total};
}

export function rankRiders(candidates: Omit<RiderCandidate, "score">[]): RiderCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    score: roundMoney(candidate.distanceKm + candidate.activeLoad * 5),
  })).sort((a, b) => a.score - b.score || a.distanceKm - b.distanceKm || a.riderId.localeCompare(b.riderId));
}
