import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {cancelledWithFeeBeforePickup, chargedCancelFee} from "../domain/customerCancel";
import {createLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {cancelledAtOf} from "../domain/partnerCancelPay";
import type {FirestoreLike} from "../firestoreTypes";
import type {SavrivoOrder} from "../types";
import {blockCustomerCod} from "./customerCodBlock";
import {persistLedgerJournalIfAbsent} from "./ledger";
import {persistCustomerCancelFeeLedger} from "./onlineDeliveryLedger";
import {asIfDeliveredAmounts} from "./orders";

/**
 * Money for a customer's own cancel after the restaurant accepted, before pickup
 * (founder 22 Nov 2026; domain/customerCancel.ts):
 * - online: no refund. The restaurant is paid what delivery would have paid it, tax is booked as at
 *   delivery, and Scraveit keeps the delivery fee, tip and its fees, as nobody made the trip.
 *   The caller withholds the seller's TCS/TDS once, as for a delivered order (index.ts);
 * - cash: nothing was collected. Scraveit pays the restaurant itself
 *   (expense:customer-cancel-fee) and cash on delivery goes off for that customer.
 * A delivery partner who reached the restaurant still gets the usual ₹15 (domain/partnerCancelPay.ts).
 * Every journal has a fixed event id, so a retried trigger can't pay twice.
 */
export interface CustomerCancelFeeSettlement {
  charged: boolean;
  restaurantPaise: number;
  codBlocked: boolean;
}

export function buildCustomerCancelFeeRestaurantJournal(input: {
  orderId: string;
  restaurantId: string;
  amountPaise: number;
  occurredAt: number;
  reason: string;
}): LedgerJournal {
  return createLedgerJournal({
    eventType: "restaurant_payable",
    eventId: `customer-cancel-fee:restaurant:${input.orderId}`,
    occurredAt: Math.round(input.occurredAt),
    orderId: input.orderId,
    actorId: "system:customer-cancel-fee",
    metadata: {
      settlementType: "customer_cancel_fee",
      paymentMethod: "cod",
      reason: input.reason.slice(0, 120),
    },
    postings: [
      {
        accountId: "expense:customer-cancel-fee",
        side: "debit",
        amountPaise: input.amountPaise,
        memo: "Scraveit pays the restaurant for a cash order the customer cancelled after it accepted",
      },
      {
        accountId: `liability:restaurant-payable:${input.restaurantId}`,
        side: "credit",
        amountPaise: input.amountPaise,
        memo: "Customer cancelled after you accepted: paid as if delivered",
      },
    ],
  });
}

export async function settleCustomerCancelFee(
  order: SavrivoOrder,
  database: FirestoreLike = firestoreDb as unknown as FirestoreLike,
): Promise<CustomerCancelFeeSettlement | null> {
  if (!cancelledWithFeeBeforePickup(order) || order.foodRescue) return null;
  const occurredAt = cancelledAtOf(order);
  const amounts = await asIfDeliveredAmounts(order);
  const restaurantPaise = amounts.restaurantPayablePaise;
  if (chargedCancelFee(order)) {
    await persistCustomerCancelFeeLedger(order, amounts);
    logger.info("CUSTOMER_CANCEL_FEE_SETTLED", {orderId: order.id, charged: true, restaurantPaise});
    return {charged: true, restaurantPaise, codBlocked: false};
  }
  if (order.paymentMethod !== "cod") return null;
  if (restaurantPaise > 0) {
    await persistLedgerJournalIfAbsent(buildCustomerCancelFeeRestaurantJournal({
      orderId: order.id,
      restaurantId: order.restaurantId,
      amountPaise: restaurantPaise,
      occurredAt,
      reason: String(order.cancelReason ?? ""),
    }), database);
  }
  await blockCustomerCod({uid: order.customerId, orderId: order.id, reason: String(order.cancelReason ?? ""), at: occurredAt}, database);
  logger.info("CUSTOMER_CANCEL_FEE_SETTLED", {orderId: order.id, charged: false, restaurantPaise, codBlocked: true});
  return {charged: false, restaurantPaise, codBlocked: true};
}
