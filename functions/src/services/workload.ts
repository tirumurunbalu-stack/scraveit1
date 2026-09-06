import {db} from "../admin";
import {ROOT} from "../config";
import {reduceRestaurantWorkload, type RestaurantWorkload} from "../domain/workload";
import type {SavrivoOrder} from "../types";

export async function reconcileRestaurantWorkload(order: SavrivoOrder): Promise<RestaurantWorkload> {
  const now = Date.now();
  const ref = db.ref(`${ROOT}/private/restaurantWorkload/${order.restaurantId}`);
  const result = await ref.transaction((current: RestaurantWorkload | null) => {
    const next = reduceRestaurantWorkload(current, order, now);
    return next === current ? undefined : next;
  }, undefined, false);
  const workload = result.snapshot.val() as RestaurantWorkload;
  if (workload) {
    // Compatibility projection for dashboards. Pricing never trusts this public
    // node; production rules must remove all client writes to restaurantLoad.
    await db.ref(`${ROOT}/restaurantLoad/${order.restaurantId}`).set({
      restaurantId: order.restaurantId,
      activeOrders: workload.activeOrders,
      preparing: workload.preparing,
      ready: workload.ready,
      updatedAt: workload.updatedAt,
    });
  }
  return workload;
}
