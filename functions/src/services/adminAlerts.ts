import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import type {FirestoreLike} from "../firestoreTypes";
import {adminUids} from "./mapsGuard";
import {notifyAdminTodo} from "./notifications";

/**
 * Push alerts to the owner's phone, only for to-dos that can't wait. Each
 * alert has a stable key, so a retry or a second run never repeats it.
 */

type Rec = Record<string, unknown>;

export async function alertAdmins(key: string, title: string, body: string, route: string, uids?: string[]): Promise<void> {
  for (const uid of uids ?? await adminUids()) {
    await notifyAdminTodo({uid, key, title, body, route}).catch((error) =>
      logger.warn("ADMIN_TODO_PUSH_FAILED", {uid, key, error: error instanceof Error ? error.message : String(error)}));
  }
}

/** What a change to a store application is worth telling the owner about. */
export function applicationAlert(appId: string, before: Rec | null, after: Rec | null): {key: string; title: string; body: string} | null {
  if (!after) return null;
  const name = String(after.restaurantName ?? "A store");
  const kind = after.storeType === "grocery" ? "grocery store" : after.storeType === "dairy" ? "dairy" : "restaurant";
  if (after.status === "submitted" && before?.status !== "submitted") {
    const again = before?.status === "changes_requested";
    return {key: `app-submitted:${appId}:${Number(after.updatedAt ?? after.submittedAt ?? 0)}`, title: again ? "Application updated" : "New store application",
      body: again ? `${name} fixed the details you asked for. Please check again.` :
        `${name} (${kind}) wants to join. Check their documents and confirm the rate.`};
  }
  const signed = (v: Rec | null) => (v?.agreement as Rec | undefined)?.status === "signed";
  if (signed(after) && !signed(before)) {
    return {key: `app-signed:${appId}:${Number((after.agreement as Rec).signedAt ?? 0)}`, title: "Agreement signed",
      body: `${name} signed the partner agreement. It's ready for you to approve.`};
  }
  return null;
}

const PLACED_LIMIT_MS = 5 * 60_000;
const COOKING_LIMIT_MS = 35 * 60_000;
const WAITING_LIMIT_MS = 10 * 60_000;

export function stuckReason(order: Rec, now: number): string | null {
  const status = String(order.status ?? "");
  const since = Number(order.updatedAt ?? order.createdAt ?? now);
  if (status === "Order placed" && now - Number(order.createdAt ?? now) > PLACED_LIMIT_MS) return "not accepted for 5 minutes";
  if ((status === "Accepted" || status === "Preparing") && now - since > COOKING_LIMIT_MS) return "cooking for over 35 minutes";
  if (status === "Ready for pickup" && !order.riderId && now - since > WAITING_LIMIT_MS) return "ready but no rider for 10 minutes";
  return null;
}

export async function watchStuckOrders(database: FirestoreLike = firestoreDb, now = Date.now()): Promise<number> {
  const snapshot = await database.collection("orders").where("status", "in", ["Order placed", "Accepted", "Preparing", "Ready for pickup"])
    .limit(300).get();
  const stuck = snapshot.docs.map((doc) => ({id: doc.id, order: doc.data() as Rec}))
    .map((x) => ({...x, reason: stuckReason(x.order, now)})).filter((x) => x.reason);
  if (!stuck.length) return 0;
  const uids = await adminUids();
  for (const {id, order, reason} of stuck) {
    await alertAdmins(`stuck:${id}:${order.status}`, "Order needs you",
      `${String(order.restaurant ?? order.restaurantName ?? "A store")}: order #${id.slice(-5).toUpperCase()} is ${reason}.`, "order:" + id, uids);
  }
  return stuck.length;
}
