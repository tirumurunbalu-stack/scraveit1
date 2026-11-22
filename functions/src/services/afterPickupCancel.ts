import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {afterPickupPlan, type AfterPickupPlan} from "../domain/foodRescue";
import {createLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {cancelledAtOf} from "../domain/partnerCancelPay";
import type {FirestoreLike} from "../firestoreTypes";
import {riderJobRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";
import {blockCustomerCod} from "./customerCodBlock";
import {persistLedgerJournalIfAbsent} from "./ledger";
import {asIfDeliveredAmounts, recordOnlinePaymentLedger} from "./orders";

/**
 * Money for an order Scraveit's admin cancelled after the delivery partner picked it up
 * (founder 22 Nov 2026; domain/foodRescue.ts afterPickupPlan):
 * - online, the customer's side: no refund; the money is settled exactly as at delivery
 *   (restaurant, the partner's trip and tip, tax, Scraveit); the caller runs the usual tax
 *   withholding once (index.ts, same lease as a delivered order);
 * - cash, or "Delivery problem": Scraveit pays the restaurant what delivery would have paid it
 *   and the partner their full trip (expense:cancel-after-pickup / expense:rider-cancellation-pay);
 *   a "Delivery problem" refund goes back by the normal refund trigger;
 * - a cash order on the customer's side also turns cash on delivery off for that customer;
 * - a Food Rescue order has no restaurant to pay (it was paid on the first order): the partner's
 *   trip is the rescue's delivery fee.
 * Every journal has a fixed event id, so a retried trigger can't pay twice, and this can run
 * again on a retry to give the same answer.
 */
export interface AfterPickupSettlement {
  plan: AfterPickupPlan;
  /** What the partner gets for this trip, in paise (shown on their job and in the cancel notice). */
  partnerPayPaise: number;
  restaurantPaise: number;
}

export function buildAfterPickupRestaurantJournal(input: {
  orderId: string;
  restaurantId: string;
  amountPaise: number;
  occurredAt: number;
  paymentMethod: SavrivoOrder["paymentMethod"];
  reason: string;
}): LedgerJournal {
  return createLedgerJournal({
    eventType: "restaurant_payable",
    eventId: `after-pickup-cancel:restaurant:${input.orderId}`,
    occurredAt: Math.round(input.occurredAt),
    orderId: input.orderId,
    actorId: "system:after-pickup-cancel",
    metadata: {
      settlementType: "cancel_after_pickup",
      paymentMethod: input.paymentMethod === "cod" ? "cod" : "online",
      reason: input.reason.slice(0, 120),
    },
    postings: [
      {
        accountId: "expense:cancel-after-pickup",
        side: "debit",
        amountPaise: input.amountPaise,
        memo: "Scraveit pays the restaurant for an order cancelled after pickup",
      },
      {
        accountId: `liability:restaurant-payable:${input.restaurantId}`,
        side: "credit",
        amountPaise: input.amountPaise,
        memo: "Order cancelled after pickup: paid as if delivered",
      },
    ],
  });
}

export function buildAfterPickupPartnerJournal(input: {
  orderId: string;
  riderId: string;
  amountPaise: number;
  occurredAt: number;
  cause: AfterPickupPlan["cause"];
}): LedgerJournal {
  return createLedgerJournal({
    eventType: "rider_incentive",
    eventId: `after-pickup-cancel:partner:${input.orderId}`,
    occurredAt: Math.round(input.occurredAt),
    orderId: input.orderId,
    actorId: "system:after-pickup-cancel",
    metadata: {
      campaignId: "after_pickup_cancel",
      displayType: "cancellation",
      settlementType: "cancellation_pay",
      reason: `${input.cause}_cancelled_after_pickup`,
    },
    postings: [
      {
        accountId: "expense:rider-cancellation-pay",
        side: "debit",
        amountPaise: input.amountPaise,
        memo: "Cancelled after pickup: Scraveit pays the full trip",
      },
      {
        accountId: `liability:rider-earnings:${input.riderId}`,
        side: "credit",
        amountPaise: input.amountPaise,
        memo: "Full trip pay (order cancelled after pickup)",
      },
    ],
  });
}

export async function settleAfterPickupCancel(
  order: SavrivoOrder,
  database: FirestoreLike = firestoreDb as unknown as FirestoreLike,
): Promise<AfterPickupSettlement | null> {
  const plan = afterPickupPlan(order);
  if (!plan) return null;
  const occurredAt = cancelledAtOf(order);
  const riderId = String(order.riderId ?? "");
  const storeDelivery = order.selfDelivery === true;
  const rescue = Boolean(order.foodRescue);
  const amounts = rescue ? null : await asIfDeliveredAmounts(order);
  let partnerPayPaise = storeDelivery ? 0 : amounts ?
    amounts.riderDeliveryEarningPaise + (plan.charged ? amounts.riderTipPaise : 0) :
    Math.max(0, Math.round(Number(order.pricing?.deliveryFee) * 100) || 0);
  const restaurantPaise = amounts ? amounts.restaurantPayablePaise : 0;
  if (plan.charged) {
    // The customer's money settles exactly as at delivery: one journal for everyone.
    await recordOnlinePaymentLedger(order);
  } else {
    if (restaurantPaise > 0) {
      await persistLedgerJournalIfAbsent(buildAfterPickupRestaurantJournal({
        orderId: order.id,
        restaurantId: order.restaurantId,
        amountPaise: restaurantPaise,
        occurredAt,
        paymentMethod: order.paymentMethod,
        reason: String(order.cancelReason ?? ""),
      }), database);
    }
    if (partnerPayPaise > 0 && riderId) {
      await persistLedgerJournalIfAbsent(buildAfterPickupPartnerJournal({
        orderId: order.id,
        riderId,
        amountPaise: partnerPayPaise,
        occurredAt,
        cause: plan.cause,
      }), database);
    } else {
      partnerPayPaise = 0;
    }
  }
  if (plan.blockCod) {
    await blockCustomerCod({uid: order.customerId, orderId: order.id, reason: String(order.cancelReason ?? ""), at: occurredAt}, database);
  }
  // The partner's job shows what this trip paid (the projection keeps it on later rebuilds).
  if (riderId && !storeDelivery && partnerPayPaise > 0) {
    const rupees = partnerPayPaise / 100;
    await riderJobRef(database, riderId, order.id).set({
      cancellationPayPaise: partnerPayPaise,
      payout: rupees,
      payoutBreakdown: {tripPay: 0, incentives: rupees, tip: 0, total: rupees, cancellationPay: rupees},
    }, {merge: true});
  }
  logger.info("AFTER_PICKUP_CANCEL_SETTLED", {
    orderId: order.id,
    cause: plan.cause,
    charged: plan.charged,
    refund: plan.refund,
    codBlocked: plan.blockCod,
    partnerPayPaise,
    restaurantPaise,
  });
  return {plan, partnerPayPaise, restaurantPaise};
}
