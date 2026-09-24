import {firestoreDb} from "../admin";
import {reduceRestaurantWorkload, type RestaurantWorkload} from "../domain/workload";
import type {DocumentReferenceLike, FirestoreLike, TransactionLike} from "../firestoreTypes";
import type {SavrivoOrder} from "../types";

export function restaurantWorkloadRef(database: FirestoreLike, restaurantId: string): DocumentReferenceLike {
  return database.collection("private").doc("restaurantWorkload").collection("byRestaurant").doc(restaurantId);
}

export async function reconcileRestaurantWorkload(order: SavrivoOrder): Promise<RestaurantWorkload> {
  const now = Date.now();
  const ref = restaurantWorkloadRef(firestoreDb, order.restaurantId);
  const workload = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as RestaurantWorkload : null;
    const next = reduceRestaurantWorkload(current, order, now);
    if (next !== current) transaction.set(ref, next);
    return next;
  });
  if (workload) {
    // Compatibility projection for dashboards. Pricing never trusts this public
    // node; production rules must remove all client writes to restaurantLoad.
    await firestoreDb.collection("restaurantLoad").doc(order.restaurantId).set({
      restaurantId: order.restaurantId,
      activeOrders: workload.activeOrders,
      preparing: workload.preparing,
      ready: workload.ready,
      updatedAt: workload.updatedAt,
    });
  }
  return workload;
}
