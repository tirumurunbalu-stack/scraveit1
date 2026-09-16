import {logger} from "firebase-functions";
import {db} from "../admin";
import {ROOT} from "../config";
import {
  buildRestaurantOrderProjection,
  shouldApplyRestaurantOrderProjection,
  type RestaurantOrderProjection,
} from "../domain/restaurantOrder";
import type {SavrivoOrder} from "../types";

export async function reconcileRestaurantOrderProjection(order: SavrivoOrder): Promise<boolean> {
  const ref = db.ref(`${ROOT}/restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}`);
  const result = await ref.transaction((current: RestaurantOrderProjection | null) => {
    const next = buildRestaurantOrderProjection(order, current);
    return shouldApplyRestaurantOrderProjection(current, next) ? next : undefined;
  }, undefined, false);
  if (!result.committed) {
    logger.info("STALE_RESTAURANT_PROJECTION_IGNORED", {
      orderId: order.id,
      incomingStatus: order.status,
      incomingUpdatedAt: order.updatedAt,
    });
  }
  return result.committed;
}
