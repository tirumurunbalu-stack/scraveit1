import type {FirestoreLike} from "../firestoreTypes";

/**
 * A restaurant's bank account, IFSC, UPI, PAN and GSTIN live in
 * restaurantPayoutProfiles/{restaurantId}, readable only by that restaurant's
 * bank-permitted staff and Scraveit admins. They used to sit inside the public
 * restaurants/{id} listing, readable by anyone; onCatalogRestaurantWritten
 * moves any that are still there.
 */
export const RESTAURANT_PAYOUT_PROFILES_COLLECTION = "restaurantPayoutProfiles";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The private profile if there is one, otherwise a not-yet-moved legacy copy. */
export function mergePayoutProfile(
  restaurant: Record<string, unknown>,
  privateProfile: unknown,
): Record<string, unknown> {
  const privateRecord = record(privateProfile);
  const legacy = record(restaurant.payoutProfile);
  const chosen = Object.keys(privateRecord).length &&
    Number(privateRecord.updatedAt ?? 0) >= Number(legacy.updatedAt ?? 0) ? privateRecord : legacy;
  return Object.keys(chosen).length ? {...restaurant, payoutProfile: chosen} : restaurant;
}

export async function withPrivatePayoutProfile(
  database: FirestoreLike,
  restaurantId: string,
  restaurant: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const snapshot = await database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).doc(restaurantId).get();
  return mergePayoutProfile(restaurant, snapshot.exists ? snapshot.data() : null);
}

export async function withPrivatePayoutProfiles(
  database: FirestoreLike,
  restaurants: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const page = await database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).get();
  const profiles: Record<string, unknown> = {};
  for (const doc of page.docs) profiles[doc.id] = doc.data();
  const out: Record<string, unknown> = {};
  for (const [id, restaurant] of Object.entries(restaurants)) out[id] = mergePayoutProfile(record(restaurant), profiles[id]);
  return out;
}

/**
 * Moves a payout profile found on the public listing into the private
 * collection (keeping whichever copy is newer) and deletes it from the
 * listing. Safe to repeat.
 */
export async function movePayoutProfileToPrivate(
  database: FirestoreLike,
  restaurantId: string,
  legacyProfile: unknown,
  deleteField: unknown,
): Promise<boolean> {
  const legacy = record(legacyProfile);
  const privateRef = database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).doc(restaurantId);
  const publicRef = database.collection("restaurants").doc(restaurantId);
  return database.runTransaction(async (transaction) => {
    const [privateSnapshot, publicSnapshot] = await Promise.all([transaction.get(privateRef), transaction.get(publicRef)]);
    const current = record(privateSnapshot.exists ? privateSnapshot.data() : null);
    if (!Object.keys(current).length || Number(legacy.updatedAt ?? 0) > Number(current.updatedAt ?? 0)) {
      transaction.set(privateRef, {...legacy, restaurantId});
    }
    if (publicSnapshot.exists && record(publicSnapshot.data()).payoutProfile !== undefined) {
      transaction.update(publicRef, {payoutProfile: deleteField});
    }
    return true;
  });
}
