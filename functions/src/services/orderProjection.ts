import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {
  buildRestaurantOrderProjection,
  shouldApplyRestaurantOrderProjection,
  type RestaurantOrderProjection,
} from "../domain/restaurantOrder";
import type {TransactionLike} from "../firestoreTypes";
import {restaurantOrderProjectionRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";

/** An online order the customer hasn't paid for yet isn't the restaurant's order yet. */
export function awaitingFirstOnlinePayment(order: Pick<SavrivoOrder, "paymentMethod" | "paymentState">): boolean {
  return (order.paymentMethod === "upi" || order.paymentMethod === "card") && ["pending", "authorized", "failed"].includes(String(order.paymentState));
}

export async function reconcileRestaurantOrderProjection(order: SavrivoOrder): Promise<boolean> {
  if (awaitingFirstOnlinePayment(order)) return false;
  const ref = restaurantOrderProjectionRef(firestoreDb, order.restaurantId, order.customerId, order.id);
  const applied = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as RestaurantOrderProjection : null;
    const next = buildRestaurantOrderProjection(order, current);
    if (!shouldApplyRestaurantOrderProjection(current, next)) return false;
    transaction.set(ref, next);
    return true;
  });
  if (!applied) {
    logger.info("STALE_RESTAURANT_PROJECTION_IGNORED", {
      orderId: order.id,
      incomingStatus: order.status,
      incomingUpdatedAt: order.updatedAt,
    });
  }
  return applied;
}
