import {createHmac, randomBytes} from "node:crypto";
import {lookup} from "node:dns/promises";
import {isIP} from "node:net";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {DomainError} from "../errors";
import type {FirestoreLike} from "../firestoreTypes";
import {restaurantMemberRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";

/**
 * "Connect your own billing software": the store gives a web address (webhook)
 * from its own POS or billing software, and every order is sent there as it is
 * placed and as its status changes, so the order count and items in their own
 * software stay in step with Scraveit. Each message is signed with the store's
 * secret (HMAC-SHA256) so their software can check it came from Scraveit.
 * Only what the kitchen needs is sent: no customer phone number or address.
 */

export const RESTAURANT_INTEGRATIONS = "restaurantIntegrations";
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => v && typeof v === "object" && !Array.isArray(v) ? v as Rec : {};
const str = (v: unknown, max = 300) => String(v ?? "").trim().slice(0, max);

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Only a public https address: never an address inside Google's network or a home router. */
export async function checkWebhookUrl(raw: string, resolve: (host: string) => Promise<string[]> = async (host) =>
  (await lookup(host, {all: true})).map((a) => a.address)): Promise<string> {
  let url: URL;
  try { url = new URL(str(raw, 500)); } catch { throw new DomainError("invalid-argument", "That isn't a web address. It starts with https://"); }
  if (url.protocol !== "https:") throw new DomainError("invalid-argument", "The address must start with https://");
  if (url.username || url.password) throw new DomainError("invalid-argument", "Leave the user name and password out of the address.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new DomainError("invalid-argument", "Use your software's public web address.");
  }
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!addresses.length) throw new DomainError("invalid-argument", "That address can't be found. Check it with your software provider.");
  if (addresses.some(privateAddress)) throw new DomainError("invalid-argument", "Use your software's public web address, not a local one.");
  return url.toString();
}

async function requireManager(database: FirestoreLike, restaurantId: string, uid: string): Promise<void> {
  const m = rec((await restaurantMemberRef(database, restaurantId, uid).get()).data());
  if (m.active === false || !["restaurant_owner", "restaurant_manager"].includes(str(m.role))) {
    throw new DomainError("permission-denied", "Only the owner or a manager can connect billing software.");
  }
}

const EVENT_FOR: Record<string, string> = {
  "Order placed": "order.placed", "Accepted": "order.accepted", "Preparing": "order.preparing",
  "Ready for pickup": "order.ready", "Handed to rider": "order.picked_up", "Out for delivery": "order.picked_up",
  "Delivered": "order.delivered", "Cancelled": "order.cancelled",
};

/** The message their software gets: the order as the kitchen sees it. */
export function orderPayload(order: SavrivoOrder, event: string, at: number): Rec {
  // The store's own prices (before any Scraveit markup), so totals match their own software.
  const items = (order.items ?? []).map((item) => ({
    id: item.itemId, name: item.name, quantity: item.quantity,
    unitPrice: Number(item.restaurantPrice ?? item.price ?? 0),
    variant: item.variant || "", addOns: (item.addOns ?? []).map((a) => ({name: a.name, price: a.price})),
    note: item.note || "", diet: item.diet || "", free: item.free === true,
  }));
  const itemTotal = items.reduce((sum, i) => sum + (i.free ? 0 : (i.unitPrice + i.addOns.reduce((n, a) => n + Number(a.price || 0), 0)) * Number(i.quantity || 0)), 0);
  return {
    event, sentAt: at,
    restaurantId: order.restaurantId,
    order: {
      id: order.id, status: order.status, placedAt: order.createdAt,
      payment: order.paymentMethod === "cod" ? "cash_on_delivery" : "paid_online",
      items, itemCount: items.reduce((n, i) => n + Number(i.quantity || 0), 0),
      currency: "INR", itemTotal: Math.round(itemTotal * 100) / 100,
      instructions: str(order.instructions, 500),
      customerFirstName: str(order.customerName, 80).split(/\s+/)[0] || "",
      ...(order.testOrder ? {test: true} : {}),
    },
  };
}

export function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<number>;
const defaultPoster: Poster = async (url, body, headers) => {
  const response = await fetch(url, {method: "POST", body, headers, redirect: "manual", signal: AbortSignal.timeout(6000)});
  return response.status;
};

async function deliver(database: FirestoreLike, restaurantId: string, cfg: Rec, payload: Rec, deliveryId: string, post: Poster, now: number) {
  const body = JSON.stringify(payload);
  let status = 0, error = "";
  try {
    const url = await checkWebhookUrl(str(cfg.url, 500));
    status = await post(url, body, {
      "content-type": "application/json", "user-agent": "Scraveit-Webhooks/1",
      "x-scraveit-event": str(payload.event), "x-scraveit-delivery": deliveryId, "x-scraveit-signature": sign(body, str(cfg.secret, 128)),
    });
    if (status < 200 || status >= 300) error = `Your software answered ${status}`;
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 160) : "Could not reach your software";
  }
  const ok = !error;
  await database.collection(RESTAURANT_INTEGRATIONS).doc(restaurantId).set({
    lastAt: now, lastEvent: str(payload.event), lastStatus: status, lastError: error, ...(ok ? {lastOkAt: now} : {}),
  }, {merge: true}).catch(() => undefined);
  return {ok, status, error};
}

const cfgCache = new Map<string, {cfg: Rec | null; until: number}>();

/** Firestore trigger body: send the order when it reaches the store and at each status change. */
export async function relayOrderChange(before: SavrivoOrder | null, after: SavrivoOrder, database: FirestoreLike = firestoreDb,
  post: Poster = defaultPoster, now = Date.now()): Promise<void> {
  if (!after?.restaurantId || after.foodRescue) return;
  // The store sees an order once it is cash or paid, and not held for the other stores of a split cart.
  const visible = (o: SavrivoOrder | null) => !!o && o.clusterHold !== true &&
    (o.paymentMethod === "cod" || o.paymentState === "paid" || o.status !== "Order placed");
  // Only when the store can see the order (cash, or paid online) and when its status changes.
  if (!visible(after)) return;
  if (before && visible(before) && before.status === after.status) return;
  const event = EVENT_FOR[after.status];
  if (!event) return;
  let cached = cfgCache.get(after.restaurantId);
  if (!cached || cached.until < now) {
    const snap = await database.collection(RESTAURANT_INTEGRATIONS).doc(after.restaurantId).get();
    cached = {cfg: snap.exists ? rec(snap.data()) : null, until: now + 60_000};
    cfgCache.set(after.restaurantId, cached);
  }
  const cfg = cached.cfg;
  if (!cfg || cfg.enabled !== true || !str(cfg.url) || !str(cfg.secret)) return;
  // Send each event once, even if this trigger runs twice.
  const deliveryId = `${after.id}_${event}`;
  const sentRef = database.collection(RESTAURANT_INTEGRATIONS).doc(after.restaurantId).collection("sent").doc(deliveryId);
  const first = await database.runTransaction(async (tx) => {
    if ((await tx.get(sentRef)).exists) return false;
    tx.set(sentRef, {at: now});
    return true;
  });
  if (!first) return;
  const result = await deliver(database, after.restaurantId, cfg, orderPayload(after, event, now), deliveryId, post, now);
  if (!result.ok) logger.warn("ORDER_WEBHOOK_FAILED", {restaurantId: after.restaurantId, orderId: after.id, event, error: result.error});
}

export async function restaurantOrderWebhook(
  uid: string,
  _token: DecodedIdToken,
  input: {action: "get" | "save" | "test" | "off"; restaurantId: string; url?: string; newSecret?: boolean},
  database: FirestoreLike = firestoreDb,
  post: Poster = defaultPoster,
  now = Date.now(),
): Promise<Rec> {
  const restaurantId = str(input.restaurantId, 120);
  await requireManager(database, restaurantId, uid);
  const ref = database.collection(RESTAURANT_INTEGRATIONS).doc(restaurantId);
  const current = rec((await ref.get()).data());
  const view = (c: Rec) => ({
    connected: c.enabled === true && Boolean(str(c.url)), url: str(c.url, 500), secret: str(c.secret, 128),
    lastAt: Number(c.lastAt ?? 0), lastOkAt: Number(c.lastOkAt ?? 0), lastStatus: Number(c.lastStatus ?? 0), lastError: str(c.lastError, 200),
  });
  if (input.action === "get") return view(current);
  if (input.action === "off") {
    await ref.set({enabled: false, updatedAt: now, updatedBy: uid}, {merge: true});
    cfgCache.delete(restaurantId);
    return view({...current, enabled: false});
  }
  if (input.action === "save") {
    const url = await checkWebhookUrl(str(input.url, 500));
    const secret = !str(current.secret) || input.newSecret ? randomBytes(24).toString("hex") : str(current.secret, 128);
    const next = {url, secret, enabled: true, updatedAt: now, updatedBy: uid, ...(current.createdAt ? {} : {createdAt: now})};
    await ref.set(next, {merge: true});
    await database.collection("audit").doc(`order_webhook_${restaurantId}_${now}`).set({
      action: "restaurant.order_webhook.save", target: restaurantId, actorId: uid, host: new URL(url).hostname, at: now,
    });
    cfgCache.delete(restaurantId);
    return view({...current, ...next});
  }
  // test
  if (!str(current.url) || current.enabled !== true) throw new DomainError("failed-precondition", "Save your software's address first.");
  const sample = {
    event: "order.test", sentAt: now, restaurantId,
    order: {id: "test-" + now, status: "Order placed", placedAt: now, payment: "paid_online",
      items: [{id: "test", name: "Test dish", quantity: 1, unitPrice: 100, variant: "", addOns: [], note: "", diet: "veg", free: false}],
      itemCount: 1, currency: "INR", itemTotal: 100, instructions: "This is a test from Scraveit. You can ignore it.", customerFirstName: "Test"},
  };
  const result = await deliver(database, restaurantId, current, sample, `test_${now}`, post, now);
  return {...view({...current, lastAt: now, lastStatus: result.status, lastError: result.error, ...(result.ok ? {lastOkAt: now} : {})}), testOk: result.ok};
}
