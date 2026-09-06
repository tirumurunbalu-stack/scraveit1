import type {SavrivoOrder} from "../types";

type ExistingRiderJob = Record<string, unknown> | null | undefined;

type ActiveRiderPhase = "pickup" | "at_restaurant" | "delivery" | "arrived";

const ACTIVE_PHASE_RANK: Record<ActiveRiderPhase, number> = {
  pickup: 0,
  at_restaurant: 1,
  delivery: 2,
  arrived: 3,
};

function assignedAt(order: SavrivoOrder): number {
  if (Number.isFinite(Number(order.riderAssignedAt))) return Number(order.riderAssignedAt);
  const events = Object.values(order.statusHistory ?? {}).filter((event) => event?.status === "Assigned");
  return events.reduce((earliest, event) => Math.min(earliest, Number(event.at) || earliest), order.createdAt);
}

function activePhase(value: unknown): ActiveRiderPhase | null {
  return typeof value === "string" && value in ACTIVE_PHASE_RANK ? value as ActiveRiderPhase : null;
}

function existingBelongsToAssignment(order: SavrivoOrder, existing: ExistingRiderJob): boolean {
  if (!order.riderId || !existing || typeof existing !== "object") return false;
  const existingOrderId = String(existing.orderId ?? "").trim();
  const existingRiderId = String(existing.riderId ?? "").trim();
  if (existingOrderId && existingOrderId !== order.id) return false;
  // riderId was added to the projection after launch. An otherwise matching
  // legacy projection is safe because callers read it from this rider's own
  // riderJobs/{riderId}/{orderId} path before rebuilding it.
  return !existingRiderId || existingRiderId === order.riderId;
}

function phaseFor(order: SavrivoOrder, existing: ExistingRiderJob): string {
  if (order.status === "Delivered" || order.status === "Cancelled") return "complete";
  const canonicalPhase: ActiveRiderPhase = order.status === "Arrived" ? "arrived" :
    ["Out for delivery", "Near you"].includes(order.status) ? "delivery" :
      order.status === "Handed to rider" ? "at_restaurant" : "pickup";
  const previousPhase = existingBelongsToAssignment(order, existing) ? activePhase(existing?.phase) : null;
  if (!previousPhase || ACTIVE_PHASE_RANK[previousPhase] <= ACTIVE_PHASE_RANK[canonicalPhase]) {
    return canonicalPhase;
  }
  // Direct rider arrival writes may race with kitchen/order snapshots. Never
  // move a confirmed same-assignment phase backwards during reconciliation.
  return previousPhase;
}

export function riderMaySeeDropDetails(order: SavrivoOrder): boolean {
  return Boolean(order.riderId) && ["Handed to rider", "Out for delivery", "Near you", "Arrived"].includes(order.status);
}

/** Minimum backend-owned projection; exact delivery data unlocks only after handover. */
export function buildRiderJobProjection(
  order: SavrivoOrder,
  existing?: ExistingRiderJob,
): Record<string, unknown> {
  const status = order.status === "Delivered" ? "completed" : order.status === "Cancelled" ? "cancelled" : "active";
  const riderFacingStatus = order.riderId && ["Accepted", "Preparing", "Ready for pickup"].includes(order.status)
    ? "Assigned" : order.status;
  const projection: Record<string, unknown> = {
    orderId: order.id,
    ...(order.riderId ? {riderId: order.riderId} : {}),
    customerId: order.customerId,
    restaurantId: order.restaurantId,
    restaurantName: order.restaurant,
    restaurantAddress: order.restaurantLocation.address,
    restaurantLat: order.restaurantLocation.lat,
    restaurantLng: order.restaurantLocation.lng,
    approximateDropZone: order.address.area || order.address.city || "Service area",
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    payout: order.pricing.deliveryFee,
    estimatedMinutes: order.etaMax,
    assignedAt: assignedAt(order),
    createdAt: assignedAt(order),
    updatedAt: order.updatedAt,
    orderStatus: riderFacingStatus,
    kitchenStatus: order.status,
    status,
    phase: phaseFor(order, existing),
  };
  if (order.restaurantPhone) projection.restaurantPhone = order.restaurantPhone;
  if (existingBelongsToAssignment(order, existing) && Number.isFinite(Number(existing?.arrivedRestaurantAt))) {
    projection.arrivedRestaurantAt = Number(existing?.arrivedRestaurantAt);
  }
  if (order.status === "Delivered") projection.completedAt = order.deliveredAt ?? order.updatedAt;
  if (riderMaySeeDropDetails(order)) {
    projection.customerName = order.customerName;
    projection.address = {
      label: order.address.label,
      area: order.address.area,
      address: order.address.address,
      lat: order.address.lat,
      lng: order.address.lng,
      ...(order.address.details ? {details: order.address.details} : {}),
      ...(order.address.city ? {city: order.address.city} : {}),
    };
    projection.items = order.items;
    projection.instructions = order.instructions;
    projection.contactless = order.contactless;
    projection.total = order.total;
    projection.paymentMethod = order.paymentMethod;
    projection.pricing = {
      deliveryFee: order.pricing.deliveryFee,
      tip: order.pricing.tip,
    };
    projection.otpRequired = true;
    // Raw phone numbers are never copied into a rider-readable projection.
    // A temporary provider-backed proxy can be exposed after handover.
    if (order.contactProxy) projection.contactProxy = order.contactProxy;
  }
  return projection;
}
