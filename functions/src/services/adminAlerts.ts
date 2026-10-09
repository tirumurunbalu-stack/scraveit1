import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import type {FirestoreLike} from "../firestoreTypes";
import {adminUids} from "./mapsGuard";
import {notifyAdminAlarm, notifyAdminTodo} from "./notifications";

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

/**
 * The alarm id for a request. One per request, not per event, so opening the
 * request on the phone stops it, and a later resubmission rings again.
 */
export function requestAlarmId(kind: "rider" | "app" | "support" | "report", id: string): string {
  return `req:${kind}:${id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160)}`;
}

/** Ring the admin app until the request is opened. */
export async function alarmAdmins(alert: RequestAlert, uids?: string[]): Promise<void> {
  for (const uid of uids ?? await adminUids()) {
    await notifyAdminAlarm({uid, ...alert}).catch((error) =>
      logger.warn("ADMIN_ALARM_PUSH_FAILED", {uid, key: alert.key, error: error instanceof Error ? error.message : String(error)}));
  }
}

export interface RequestAlert {key: string; alarmId: string; title: string; body: string; route: string; issuedAt: number}

/** A rider sending (or resending) their application. */
export function riderApplicationAlert(riderId: string, before: Rec | null, after: Rec | null, now = Date.now()): RequestAlert | null {
  if (!after || after.status !== "submitted" || before?.status === "submitted") return null;
  const name = String(after.fullName ?? "A rider").slice(0, 60);
  const city = String(after.city ?? "").slice(0, 40);
  const again = before?.status === "changes_requested" || before?.status === "rejected";
  const at = Number(after.submittedAt ?? after.updatedAt ?? now) || now;
  return {key: `rider-app:${riderId}:${at}`, alarmId: requestAlarmId("rider", riderId), route: `rider:${riderId}`, issuedAt: now,
    title: again ? "Rider application updated" : "New rider application",
    body: again ? `${name} sent their application again. Please check it.` :
      `${name}${city ? ` (${city})` : ""} wants to deliver. Check their Aadhaar, face scan and PAN.`};
}

/** A customer, rider or store opening a support ticket. */
export function supportTicketAlert(ticketId: string, ticket: Rec | null, now = Date.now()): RequestAlert | null {
  if (!ticket || ticket.status === "closed") return null;
  const uid = String(ticket.uid ?? "");
  if (!uid) return null;
  const who = String(ticket.customerName || ticket.riderName || ticket.restaurantName || ticket.email || "Someone").slice(0, 60);
  const topic = String(ticket.topic ?? "Support").slice(0, 60);
  const urgent = ticket.priority === "high";
  return {key: `support:${ticketId}`, alarmId: requestAlarmId("support", ticketId), route: `support:${uid}:${ticketId}`, issuedAt: now,
    title: urgent ? "Urgent support request" : "New support request",
    body: `${who}: ${topic}${ticket.orderId ? ` · order #${String(ticket.orderId).slice(-5).toUpperCase()}` : ""}`};
}

/** What a change to a store application is worth telling the owner about. */
export function applicationAlert(appId: string, before: Rec | null, after: Rec | null, now = Date.now()): RequestAlert | null {
  if (!after) return null;
  const name = String(after.restaurantName ?? "A store");
  const kind = after.storeType === "grocery" ? "grocery store" : after.storeType === "dairy" ? "dairy" : "restaurant";
  if (after.status === "submitted" && before?.status !== "submitted") {
    const again = before?.status === "changes_requested";
    return {key: `app-submitted:${appId}:${Number(after.updatedAt ?? after.submittedAt ?? 0)}`, alarmId: requestAlarmId("app", appId), route: `app:${appId}`, issuedAt: now,
      title: again ? "Application updated" : "New store application",
      body: again ? `${name} fixed the details you asked for. Please check again.` :
        `${name} (${kind}) wants to join. Check their documents and confirm the rate.`};
  }
  const signed = (v: Rec | null) => (v?.agreement as Rec | undefined)?.status === "signed";
  if (signed(after) && !signed(before)) {
    return {key: `app-signed:${appId}:${Number((after.agreement as Rec).signedAt ?? 0)}`, alarmId: requestAlarmId("app", appId), route: `app:${appId}`, issuedAt: now,
      title: "Agreement signed",
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
