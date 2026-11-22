import type {OrderStatus} from "../types";

/**
 * Cancelling after pickup (founder 22 Nov 2026). Once the delivery partner has
 * the food, only Scraveit's admin may cancel, and only with one of three
 * reasons. Before this, nothing after "Assigned" could be cancelled at all.
 */
export const AFTER_PICKUP_STATUSES: readonly OrderStatus[] = ["Handed to rider", "Out for delivery", "Near you", "Arrived"];

export function isAfterPickupStatus(status: unknown): boolean {
  return typeof status === "string" && (AFTER_PICKUP_STATUSES as readonly string[]).includes(status);
}

/** The customer's side: they are charged as if it was delivered (online) or lose cash on delivery (COD). */
export const AFTER_PICKUP_CUSTOMER_REASONS = ["Customer cancelled after pickup", "Customer not reachable at door"] as const;
/** Scraveit's side (an accident, spilt food): the customer gets everything back. */
export const AFTER_PICKUP_PROBLEM_REASON = "Delivery problem";
export const AFTER_PICKUP_CANCEL_REASONS = [...AFTER_PICKUP_CUSTOMER_REASONS, AFTER_PICKUP_PROBLEM_REASON] as const;

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isAfterPickupCustomerReason(value: unknown): boolean {
  const reason = normalized(value);
  return !!reason && AFTER_PICKUP_CUSTOMER_REASONS.some((entry) => entry.toLowerCase() === reason);
}

export function isAfterPickupCancelReason(value: unknown): boolean {
  const reason = normalized(value);
  return !!reason && AFTER_PICKUP_CANCEL_REASONS.some((entry) => entry.toLowerCase() === reason);
}
