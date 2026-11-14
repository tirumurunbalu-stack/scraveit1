import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {restaurantRef, storeHoursStateRef} from "../firestorePaths";
import {storeHoursChange} from "../domain/storeHours";

/**
 * Opens and closes every store at its own saved times. Each opening or closing
 * is applied once (remembered in private/storeHours/stores/{id}), so a manual
 * switch in the store app holds until the store's next opening or closing time.
 */
export async function applyStoreHours(now = Date.now()): Promise<{checked: number; opened: number; closed: number}> {
  const snapshot = await firestoreDb.collection("restaurants")
    .select("opensAt", "opensUntil", "openDays", "open", "archived").get();
  let opened = 0, closed = 0;
  for (const doc of snapshot.docs) {
    const store = doc.data() as Record<string, unknown>;
    if (!store.opensAt || !store.opensUntil || store.archived === true) continue;
    try {
      const stateRef = storeHoursStateRef(firestoreDb, doc.id);
      const state = await stateRef.get();
      const lastKey = state.exists ? String((state.data() as {lastKey?: unknown}).lastKey ?? "") : "";
      const change = storeHoursChange(store, lastKey, now);
      if (!change) continue;
      if ((store.open === true) !== change.open) {
        await restaurantRef(firestoreDb, doc.id).set(
          {open: change.open, updatedAt: now, updatedBy: change.open ? "store-hours-open" : "store-hours-close"}, {merge: true});
        if (change.open) opened++; else closed++;
        logger.info(change.open ? "STORE_HOURS_OPENED" : "STORE_HOURS_CLOSED", {restaurantId: doc.id, key: change.key});
      }
      await stateRef.set({lastKey: change.key, lastOpen: change.open, appliedAt: now}, {merge: true});
    } catch (error) {
      logger.warn("STORE_HOURS_FAILED", {restaurantId: doc.id, error: String(error)});
    }
  }
  return {checked: snapshot.size, opened, closed};
}
