import {firestoreDb} from "../admin";
import {FOOD_RESCUE_COLLECTION, rescueHoldsPartner, type FoodRescueOffer} from "../domain/foodRescue";

/** Read at most every 5 seconds per server copy: dispatch and the store-page partner check both ask. */
const CACHE_MS = 5_000;
let cache: {at: number; ids: Set<string>} | null = null;

/**
 * Delivery partners waiting where they are with Food Rescue food (domain/foodRescue.ts): no new
 * orders for them until the food is bought or the 15 minutes end (founder 22 Nov 2026).
 */
export async function foodRescueHolderIds(now = Date.now()): Promise<Set<string>> {
  if (cache && now - cache.at < CACHE_MS) return cache.ids;
  const snapshot = await firestoreDb.collection(FOOD_RESCUE_COLLECTION)
    .where("status", "in", ["open", "held"]).limit(200).get();
  const ids = new Set(snapshot.docs
    .map((doc) => doc.data() as FoodRescueOffer)
    .filter((offer) => rescueHoldsPartner(offer, now))
    .map((offer) => String(offer.riderId ?? ""))
    .filter(Boolean));
  cache = {at: now, ids};
  return ids;
}

/** A new offer or a finished one: the next check reads again. */
export function forgetFoodRescueHolders(): void {
  cache = null;
}
