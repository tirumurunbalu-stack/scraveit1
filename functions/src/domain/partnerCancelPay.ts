import {createLedgerJournal, type LedgerJournal} from "./ledger";
import {AFTER_PICKUP_PROBLEM_REASON, isAfterPickupCustomerReason, isAfterPickupStatus} from "./afterPickup";

/**
 * Founder 21 Nov 2026: when an order is cancelled (by the customer, the
 * restaurant or Scraveit's admin) after the delivery partner has reached the
 * restaurant, the partner still gets ₹15 for the trip there. (A cancel after pickup, by the admin or, since
 * 22 Nov 2026, by the customer with the 100% fee, pays the full trip instead.) Scraveit pays it; a
 * customer's own cancel after the restaurant accepts carries the 100% cancellation fee (customerCancel.ts).
 */
export const PARTNER_CANCEL_PAY_PAISE = 1_500;

/** The admin app's reason for a cancel the customer asked for. */
export const CUSTOMER_CANCEL_ADMIN_REASON = "Customer cancellation approved";
/** The admin app's reasons for a cancel the restaurant caused. */
export const RESTAURANT_CANCEL_ADMIN_REASONS = ["Restaurant unable to fulfil", "Item unavailable"] as const;
/** The admin app's other reasons: Scraveit's own call. */
export const SCRAVEIT_CANCEL_ADMIN_REASONS = ["Duplicate order", "Serviceability issue"] as const;

export type PartnerCancelCause = "customer" | "restaurant" | "scraveit";

export type PartnerCancelPayOutcome =
  | "paid"
  | "not_cancelled"
  | "not_covered"
  | "no_partner"
  | "self_delivery"
  | "not_arrived"
  // Cancelled after pickup: the partner gets the full trip instead (services/afterPickupCancel.ts).
  | "after_pickup";

export interface PartnerCancelPayOrder {
  status?: unknown;
  riderId?: unknown;
  selfDelivery?: unknown;
  cancelledByRole?: unknown;
  cancelReason?: unknown;
  statusBeforeTerminal?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The customer cancelled: in their own app, or Scraveit's admin (the owner or
 * an ops admin, never a restaurant) cancelled with the customer's request.
 */
export function isCustomerCancellation(order: PartnerCancelPayOrder): boolean {
  return cancelCause(order) === "customer";
}

/** The cause an admin-app reason names, or null for any other text. */
function adminReasonCause(value: unknown): PartnerCancelCause | null {
  const reason = text(value).toLowerCase();
  if (!reason) return null;
  if (reason === CUSTOMER_CANCEL_ADMIN_REASON.toLowerCase()) return "customer";
  if (RESTAURANT_CANCEL_ADMIN_REASONS.some((entry) => entry.toLowerCase() === reason)) return "restaurant";
  if (SCRAVEIT_CANCEL_ADMIN_REASONS.some((entry) => entry.toLowerCase() === reason)) return "scraveit";
  // After pickup (domain/afterPickup.ts): the customer's two reasons, and Scraveit's delivery problem.
  if (isAfterPickupCustomerReason(reason)) return "customer";
  if (reason === AFTER_PICKUP_PROBLEM_REASON.toLowerCase()) return "scraveit";
  return null;
}

/** One of the admin app's fixed cancel reasons (marks a cancel made in the admin app). */
export function isAdminCancelReason(value: unknown): boolean {
  return adminReasonCause(value) !== null;
}

/**
 * Who caused the cancel, for partner pay and reports. The restaurant's own app
 * cancels as "staff". Scraveit's admin (the owner or an ops admin) picks one of
 * the admin app's reasons; any other admin text is Scraveit's own call.
 * A "customer" cancel is always the customer's, whatever reason text it
 * carries, so a customer can never shift a cancel onto the restaurant.
 * (An admin cancelling their own test order is saved as the admin: authz.ts.)
 * A system cancel (unpaid online order) is null: no pay.
 */
export function cancelCause(order: PartnerCancelPayOrder): PartnerCancelCause | null {
  if (order.cancelledByRole === "customer") return "customer";
  if (order.cancelledByRole === "staff") return "restaurant";
  if (order.cancelledByRole !== "ops_admin" && order.cancelledByRole !== "owner") return null;
  return adminReasonCause(order.cancelReason) ?? "scraveit";
}

/**
 * ₹15 only for the partner who was on the order and whose arrival at the
 * restaurant the server verified (GPS) before the cancel.
 */
export function partnerCancelPayDecision(input: {
  order: PartnerCancelPayOrder;
  arrival: unknown;
  cancelledAt: number;
}): {payPaise: number; outcome: PartnerCancelPayOutcome; cause?: PartnerCancelCause} {
  const {order} = input;
  if (order.status !== "Cancelled") return {payPaise: 0, outcome: "not_cancelled"};
  const cause = cancelCause(order);
  if (!cause) return {payPaise: 0, outcome: "not_covered"};
  const riderId = text(order.riderId);
  if (!riderId) return {payPaise: 0, outcome: "no_partner"};
  if (order.selfDelivery === true) return {payPaise: 0, outcome: "self_delivery"};
  if (isAfterPickupStatus(order.statusBeforeTerminal)) return {payPaise: 0, outcome: "after_pickup", cause};
  const arrival = input.arrival && typeof input.arrival === "object" ? input.arrival as Record<string, unknown> : {};
  const arrivedAt = Number(arrival.arrivedAt);
  const arrived = arrival.status === "verified" && text(arrival.riderId) === riderId &&
    Number.isFinite(arrivedAt) && arrivedAt > 0 && arrivedAt <= input.cancelledAt;
  if (!arrived) return {payPaise: 0, outcome: "not_arrived", cause};
  return {payPaise: PARTNER_CANCEL_PAY_PAISE, outcome: "paid", cause};
}

/** When the order was cancelled: its Cancelled event, else its last update. */
export function cancelledAtOf(order: {statusHistory?: Record<string, {status?: unknown; at?: unknown}>; updatedAt?: unknown}): number {
  const events = Object.values(order.statusHistory ?? {})
    .filter((event) => event?.status === "Cancelled")
    .map((event) => Number(event.at))
    .filter((at) => Number.isFinite(at) && at > 0);
  if (events.length) return Math.min(...events);
  const updatedAt = Number(order.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? Math.round(updatedAt) : Date.now();
}

/** Scraveit pays the partner; one journal per order (the event id makes it idempotent). */
export function buildPartnerCancelPayJournal(input: {
  orderId: string;
  riderId: string;
  amountPaise: number;
  occurredAt: number;
  cause?: PartnerCancelCause;
}): LedgerJournal {
  return createLedgerJournal({
    eventType: "rider_incentive",
    eventId: `partner-cancel-pay:${input.orderId}`,
    occurredAt: Math.round(input.occurredAt),
    orderId: input.orderId,
    actorId: "system:partner-cancel-pay",
    metadata: {
      campaignId: "partner_cancel_pay",
      displayType: "cancellation",
      settlementType: "cancellation_pay",
      reason: `${input.cause ?? "customer"}_cancelled_after_partner_arrived`,
    },
    postings: [
      {
        accountId: "expense:rider-cancellation-pay",
        side: "debit",
        amountPaise: input.amountPaise,
        memo: `${input.cause === "restaurant" ? "Restaurant" : input.cause === "scraveit" ? "Scraveit" : "Customer"} cancelled after the delivery partner reached the restaurant`,
      },
      {
        accountId: `liability:rider-earnings:${input.riderId}`,
        side: "credit",
        amountPaise: input.amountPaise,
        memo: "Cancellation pay",
      },
    ],
  });
}
