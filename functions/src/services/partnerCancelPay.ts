import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {
  buildPartnerCancelPayJournal,
  cancelledAtOf,
  partnerCancelPayDecision,
  type PartnerCancelPayOutcome,
} from "../domain/partnerCancelPay";
import type {FirestoreLike} from "../firestoreTypes";
import {riderJobRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";
import {persistLedgerJournalIfAbsent} from "./ledger";

/**
 * Customer or restaurant cancelled after the delivery partner reached the restaurant: credit
 * the partner ₹15 once, and put it on their job so the app shows it. Safe to
 * repeat: the journal's event id is the order, and the job write is a merge.
 */
export async function payPartnerForCancel(
  order: SavrivoOrder,
  database: FirestoreLike = firestoreDb as unknown as FirestoreLike,
): Promise<{payPaise: number; outcome: PartnerCancelPayOutcome}> {
  if (order.status !== "Cancelled" || !order.riderId) return {payPaise: 0, outcome: order.status !== "Cancelled" ? "not_cancelled" : "no_partner"};
  const arrival = await database.collection("riderRestaurantArrivals").doc(order.id).get();
  const cancelledAt = cancelledAtOf(order);
  const decision = partnerCancelPayDecision({
    order,
    arrival: arrival.exists ? arrival.data() : null,
    cancelledAt,
  });
  if (decision.payPaise <= 0) return decision;
  const riderId = String(order.riderId);
  const journal = buildPartnerCancelPayJournal({
    orderId: order.id,
    riderId,
    amountPaise: decision.payPaise,
    occurredAt: cancelledAt,
    ...(decision.cause ? {cause: decision.cause} : {}),
  });
  await persistLedgerJournalIfAbsent(journal, database);
  await riderJobRef(database, riderId, order.id).set({
    cancellationPayPaise: decision.payPaise,
    payout: decision.payPaise / 100,
    payoutBreakdown: {tripPay: 0, incentives: decision.payPaise / 100, tip: 0, total: decision.payPaise / 100, cancellationPay: decision.payPaise / 100},
  }, {merge: true});
  logger.info("PARTNER_CANCEL_PAY", {orderId: order.id, riderId, payPaise: decision.payPaise, cause: decision.cause});
  return decision;
}
