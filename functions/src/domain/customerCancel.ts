import type {OrderStatus, SavrivoOrder} from "../types";
import {isAfterPickupStatus} from "./afterPickup";
import {chargedAfterPickup} from "./foodRescue";

/**
 * The customer's own Cancel order (founder 22 Nov 2026): free until the restaurant accepts.
 * Once it has accepted, the food is being made, so a 100% cancellation fee applies, and the
 * customer sees it and confirms it before anything is cancelled:
 * - online: no refund; the restaurant is paid as if delivered (services/customerCancelFee.ts);
 * - cash: nothing was collected, so cash on delivery goes off for that customer and Scraveit
 *   pays the restaurant itself;
 * - after pickup the same fee applies and the order follows the cancel-after-pickup rules
 *   (domain/foodRescue.ts afterPickupPlan), Food Rescue included.
 * The fee is stamped on the order when it is cancelled (`cancellationFee`), so older cancels
 * keep the refund they always had.
 */
export const CANCEL_FEE_PERCENT = 100;
export const CUSTOMER_CANCEL_FREE_REASON = "Customer cancelled before the restaurant accepted";
export const CUSTOMER_CANCEL_FEE_REASON = "Customer cancelled after the restaurant accepted";
/** The customer cancel reason the after-pickup rules know (domain/afterPickup.ts). */
export const CUSTOMER_CANCEL_AFTER_PICKUP_REASON = "Customer cancelled after pickup";

const FEE_STATUSES: readonly OrderStatus[] = [
  "Accepted", "Preparing", "Ready for pickup", "Assigned",
  "Handed to rider", "Out for delivery", "Near you", "Arrived",
];

export interface CancellationFee {
  percent: number;
  /** The order total the customer gave up, in paise (nothing is collected on a cash order). */
  amountPaise: number;
  acceptedAt: number;
}

export function customerCancelFeeApplies(status: unknown): boolean {
  return typeof status === "string" && (FEE_STATUSES as readonly string[]).includes(status);
}

/** The fee a customer accepts by cancelling this order now, or null when cancelling is free. */
export function customerCancelFee(order: Pick<SavrivoOrder, "status" | "total">, now: number): CancellationFee | null {
  if (!customerCancelFeeApplies(order.status)) return null;
  return {percent: CANCEL_FEE_PERCENT, amountPaise: Math.max(0, Math.round(Number(order.total) * 100) || 0), acceptedAt: now};
}

export function customerCancelReason(status: OrderStatus, fee: boolean): string {
  if (isAfterPickupStatus(status)) return CUSTOMER_CANCEL_AFTER_PICKUP_REASON;
  return fee ? CUSTOMER_CANCEL_FEE_REASON : CUSTOMER_CANCEL_FREE_REASON;
}

type FeeFacts = Pick<SavrivoOrder, "status" | "statusBeforeTerminal" | "cancelledByRole" | "cancelReason" |
  "paymentMethod" | "paymentState" | "cancellationFee">;

/** The customer cancelled with the fee before pickup (after pickup: domain/foodRescue.ts). */
export function cancelledWithFeeBeforePickup(order: FeeFacts): boolean {
  return order.status === "Cancelled" && order.cancelledByRole === "customer" &&
    Number(order.cancellationFee?.percent) > 0 && !isAfterPickupStatus(order.statusBeforeTerminal);
}

/** Online, paid, cancelled with the fee before pickup: never refunded (services/payments.ts). */
export function chargedCancelFee(order: FeeFacts): boolean {
  return cancelledWithFeeBeforePickup(order) && order.paymentMethod !== "cod" && order.paymentState === "paid";
}

/** A cancelled order whose payment is kept, not refunded: after pickup or with the 100% fee. */
export function keptOnCancel(order: FeeFacts): boolean {
  return chargedAfterPickup(order) || chargedCancelFee(order);
}
