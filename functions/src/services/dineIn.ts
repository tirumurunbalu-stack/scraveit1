import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {priceCart} from "../domain/order";
import {DomainError} from "../errors";
import type {CatalogItem} from "../types";
import type {DecodedIdToken} from "firebase-admin/auth";
import {canManageRestaurantOrders} from "./authz";
import {notifyRestaurantDineIn, notifyUserDineIn} from "./notifications";

/**
 * Dine-in, Phase 1: customers book a table ahead (optional) and order from the
 * table by scanning its QR code. Everyone who scans the same table joins one
 * table session and one bill. The food is billed and paid at the restaurant
 * (no money passes through Scraveit), so nothing here touches settlements,
 * GST/TDS or the rider-as-supplier model. Dine-in fee: 0 at launch.
 *
 *   restaurants/{id}.dineIn            settings, edited in the restaurant app
 *   dineBookings/{id}                  bookings
 *   tableSessions/{id}                 one sitting at one table
 *   tableSessions/{id}/rounds/{id}     each round sent to the kitchen
 *   private/dineIn/tables/{rid}__{tid} which session a table has open now
 *   private/dineIn/standing/{uid}      no-show history and pause
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const HOLD_MINUTES = 15;
const FREE_CANCEL_MS = 60 * 60 * 1000;
const NO_SHOW_LIMIT = 3;
const NO_SHOW_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const PAUSE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BOOK_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const MAX_ROUNDS = 30;
const MAX_MEMBERS = 20;

export interface DineInTable {id: string; label: string; seats: number}
export interface DineInSettings {
  enabled: boolean;
  autoAccept: boolean;
  tables: DineInTable[];
  slotMinutes: number;
  openFrom: string;
  openTo: string;
  maxParty: number;
}

const timeOk = (value: unknown, fallback: string) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
export function normalizeDineIn(value: unknown): DineInSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const tables = (Array.isArray(raw.tables) ? raw.tables : []).slice(0, 100).map((entry, index) => {
    const table = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const id = String(table.id ?? index + 1).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || String(index + 1);
    return {id, label: String(table.label || `Table ${id}`).slice(0, 30), seats: Math.max(1, Math.min(30, Math.floor(Number(table.seats) || 4)))};
  });
  const slot = Number(raw.slotMinutes);
  return {
    enabled: raw.enabled === true && tables.length > 0,
    autoAccept: raw.autoAccept !== false,
    tables,
    slotMinutes: [15, 30, 60].includes(slot) ? slot : 30,
    openFrom: timeOk(raw.openFrom, "12:00"),
    openTo: timeOk(raw.openTo, "22:30"),
    maxParty: Math.max(1, Math.min(30, Math.floor(Number(raw.maxParty) || 10))),
  };
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Minutes after midnight in India for a timestamp. */
export function istMinutes(at: number): number {
  const date = new Date(at + IST_OFFSET_MS);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** A slot is bookable when it is on the slot grid, inside dine-in hours, and leaves room to finish. */
export function slotAllowed(settings: DineInSettings, slotAt: number, now: number): string | null {
  if (!Number.isFinite(slotAt) || slotAt % 60_000 !== 0) return "Pick a time from the list.";
  if (slotAt < now + 15 * 60_000) return "Book at least 15 minutes ahead.";
  if (slotAt > now + MAX_BOOK_AHEAD_MS) return "Bookings open up to 14 days ahead.";
  const minutes = istMinutes(slotAt);
  if (minutes % settings.slotMinutes !== 0) return "Pick a time from the list.";
  if (minutes < minutesOf(settings.openFrom) || minutes > minutesOf(settings.openTo) - settings.slotMinutes) return "That time is outside dine-in hours.";
  return null;
}

async function loadDineInRestaurant(restaurantId: string): Promise<{restaurant: Record<string, unknown>; settings: DineInSettings}> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(restaurantId)) throw new DomainError("invalid-argument", "Unknown restaurant.");
  const snapshot = await firestoreDb.collection("restaurants").doc(restaurantId).get();
  const restaurant = snapshot.exists ? snapshot.data() as Record<string, unknown> : null;
  if (!restaurant || restaurant.archived === true) throw new DomainError("not-found", "Restaurant not found.");
  const settings = normalizeDineIn(restaurant.dineIn);
  if (!settings.enabled) throw new DomainError("failed-precondition", "This restaurant isn’t taking dine-in right now.");
  return {restaurant, settings};
}

async function customerName(uid: string): Promise<string> {
  const snapshot = await firestoreDb.collection("users").doc(uid).get().catch(() => null);
  const name = snapshot && snapshot.exists ? String((snapshot.data() as Record<string, unknown>).name || "") : "";
  return (name.trim().split(/\s+/)[0] || "Guest").slice(0, 40);
}

const standingRef = (uid: string) => firestoreDb.collection("private").doc("dineIn").collection("standing").doc(uid);
const tablePointerRef = (restaurantId: string, tableId: string) =>
  firestoreDb.collection("private").doc("dineIn").collection("tables").doc(`${restaurantId}__${tableId}`);
const bookingRef = (id: string) => firestoreDb.collection("dineBookings").doc(id);
const sessionRef = (id: string) => firestoreDb.collection("tableSessions").doc(id);

function slotLabel(slotAt: number): string {
  return new Date(slotAt).toLocaleString("en-IN", {timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit"});
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export async function bookTable(uid: string, input: {restaurantId: string; slotAt: number; party: number; note?: string}, now = Date.now()) {
  const {restaurant, settings} = await loadDineInRestaurant(input.restaurantId);
  const party = Math.floor(Number(input.party));
  if (!(party >= 1 && party <= settings.maxParty)) throw new DomainError("invalid-argument", `Tables here take up to ${settings.maxParty} people.`);
  const slotError = slotAllowed(settings, Number(input.slotAt), now);
  if (slotError) throw new DomainError("invalid-argument", slotError);
  const standing = await standingRef(uid).get();
  const pausedUntil = standing.exists ? Number((standing.data() as Record<string, unknown>).pausedUntil || 0) : 0;
  if (pausedUntil > now) throw new DomainError("failed-precondition", `Table bookings are paused until ${new Date(pausedUntil).toLocaleDateString("en-IN", {timeZone: "Asia/Kolkata"})} after missed bookings. You can still walk in and scan a table.`);

  const window = settings.slotMinutes * 3 * 60_000;
  const [nearby, mine, name] = await Promise.all([
    firestoreDb.collection("dineBookings").where("restaurantId", "==", input.restaurantId)
      .where("slotAt", ">", input.slotAt - window).where("slotAt", "<", input.slotAt + window).get(),
    firestoreDb.collection("dineBookings").where("customerId", "==", uid).where("slotAt", ">=", now - 3 * 60 * 60 * 1000).get(),
    customerName(uid),
  ]);
  const active = (status: unknown) => status === "requested" || status === "confirmed";
  if (mine.docs.some((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return active(data.status) && data.restaurantId === input.restaurantId && Math.abs(Number(data.slotAt) - input.slotAt) < 4 * 60 * 60 * 1000;
  })) throw new DomainError("already-exists", "You already have a booking here around that time.");
  const fitting = settings.tables.filter((table) => table.seats >= party).length || (party <= Math.max(...settings.tables.map((t) => t.seats)) ? 1 : 0);
  const taken = nearby.docs.filter((doc) => active((doc.data() as Record<string, unknown>).status) && Number((doc.data() as Record<string, unknown>).party) >= Math.min(party, 2)).length;
  if (!fitting || taken >= fitting) throw new DomainError("resource-exhausted", "No table for that many people at that time. Try another time.");

  const ref = firestoreDb.collection("dineBookings").doc();
  const booking = {
    id: ref.id,
    restaurantId: input.restaurantId,
    restaurantName: String(restaurant.name || "Restaurant").slice(0, 120),
    customerId: uid,
    customerName: name,
    slotAt: input.slotAt,
    party,
    note: String(input.note || "").slice(0, 200),
    status: settings.autoAccept ? "confirmed" : "requested",
    createdAt: now,
    updatedAt: now,
    remindedLong: false,
    remindedShort: false,
  };
  await ref.set(booking);
  await notifyRestaurantDineIn({restaurantId: input.restaurantId, key: `booking:${ref.id}:new`,
    title: settings.autoAccept ? `New booking · ${party} people` : `Booking request · ${party} people`,
    body: `${name} for ${slotLabel(input.slotAt)}${settings.autoAccept ? " (accepted automatically)" : ". Accept it in the app."}`}).catch(() => {});
  return booking;
}

export async function respondToBooking(token: DecodedIdToken, input: {bookingId: string; accept: boolean}, now = Date.now()) {
  const ref = bookingRef(input.bookingId);
  const snapshot = await ref.get();
  const booking = snapshot.exists ? snapshot.data() as Record<string, unknown> : null;
  if (!booking) throw new DomainError("not-found", "Booking not found.");
  await requireStaff(token, String(booking.restaurantId));
  if (booking.status !== "requested" && !(booking.status === "confirmed" && !input.accept)) throw new DomainError("failed-precondition", "This booking was already handled.");
  const status = input.accept ? "confirmed" : "declined";
  await ref.update({status, updatedAt: now, respondedBy: token.uid});
  await notifyUserDineIn({uid: String(booking.customerId), key: `booking:${input.bookingId}:${status}`,
    title: input.accept ? "Table booked 🎉" : "Booking not accepted",
    body: input.accept ? `${booking.restaurantName} is expecting ${booking.party} of you on ${slotLabel(Number(booking.slotAt))}.` : `${booking.restaurantName} can’t take this booking. Try another time.`,
    data: {type: "DINE_BOOKING", bookingId: input.bookingId}}).catch(() => {});
  return {status};
}

export async function cancelBooking(uid: string, input: {bookingId: string}, now = Date.now()) {
  const ref = bookingRef(input.bookingId);
  const snapshot = await ref.get();
  const booking = snapshot.exists ? snapshot.data() as Record<string, unknown> : null;
  if (!booking || booking.customerId !== uid) throw new DomainError("not-found", "Booking not found.");
  if (booking.status !== "requested" && booking.status !== "confirmed") throw new DomainError("failed-precondition", "This booking can’t be cancelled now.");
  const late = Number(booking.slotAt) - now < FREE_CANCEL_MS;
  await ref.update({status: "cancelled", lateCancel: late, updatedAt: now});
  if (late) await recordMiss(uid, input.bookingId, now);
  await notifyRestaurantDineIn({restaurantId: String(booking.restaurantId), key: `booking:${input.bookingId}:cancelled`,
    title: "Booking cancelled", body: `${booking.customerName} cancelled ${booking.party} people for ${slotLabel(Number(booking.slotAt))}.`}).catch(() => {});
  return {status: "cancelled", late};
}

async function recordMiss(uid: string, bookingId: string, now: number): Promise<void> {
  await firestoreDb.runTransaction(async (transaction) => {
    const ref = standingRef(uid);
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? snapshot.data() as Record<string, unknown> : {};
    const misses = (Array.isArray(data.misses) ? data.misses as Array<{at: number; bookingId: string}> : [])
      .filter((miss) => now - Number(miss.at) < NO_SHOW_WINDOW_MS && miss.bookingId !== bookingId);
    misses.push({at: now, bookingId});
    const pausedUntil = misses.length >= NO_SHOW_LIMIT ? now + PAUSE_MS : Number(data.pausedUntil || 0);
    transaction.set(ref, {uid, misses: misses.slice(-10), pausedUntil, updatedAt: now});
  });
}

// ---------------------------------------------------------------------------
// Table sessions
// ---------------------------------------------------------------------------

export async function openTable(uid: string, input: {restaurantId: string; tableId: string}, now = Date.now()) {
  const {restaurant, settings} = await loadDineInRestaurant(input.restaurantId);
  const table = settings.tables.find((entry) => entry.id === input.tableId);
  if (!table) throw new DomainError("not-found", "That table code isn’t set up here.");
  const name = await customerName(uid);
  // A booking for this customer around now checks in at this table.
  const bookings = await firestoreDb.collection("dineBookings").where("customerId", "==", uid)
    .where("slotAt", ">=", now - 90 * 60_000).where("slotAt", "<=", now + 60 * 60_000).get();
  const booking = bookings.docs.map((doc) => doc.data() as Record<string, unknown>)
    .find((entry) => entry.restaurantId === input.restaurantId && entry.status === "confirmed");

  const pointer = tablePointerRef(input.restaurantId, table.id);
  const result = await firestoreDb.runTransaction(async (transaction) => {
    const current = await transaction.get(pointer);
    const sessionId = current.exists ? String((current.data() as Record<string, unknown>).sessionId || "") : "";
    if (sessionId) {
      const existing = await transaction.get(sessionRef(sessionId));
      const data = existing.exists ? existing.data() as Record<string, unknown> : null;
      if (data && (data.status === "open" || data.status === "bill") && now - Number(data.openedAt || 0) < SESSION_MAX_AGE_MS) {
        const memberUids = Array.isArray(data.memberUids) ? data.memberUids as string[] : [];
        if (!memberUids.includes(uid)) {
          if (memberUids.length >= MAX_MEMBERS) throw new DomainError("resource-exhausted", "This table is full.");
          transaction.update(sessionRef(sessionId), {memberUids: [...memberUids, uid],
            members: [...(Array.isArray(data.members) ? data.members as unknown[] : []), {uid, name, joinedAt: now}], updatedAt: now});
        }
        return {sessionId, created: false};
      }
    }
    const ref = firestoreDb.collection("tableSessions").doc();
    transaction.set(ref, {
      id: ref.id, restaurantId: input.restaurantId, restaurantName: String(restaurant.name || "Restaurant").slice(0, 120),
      tableId: table.id, tableLabel: table.label, status: "open", openedAt: now, updatedAt: now,
      hostUid: uid, memberUids: [uid], members: [{uid, name, joinedAt: now}],
      subtotal: 0, rounds: 0, memberTotals: {}, waiterCalledAt: 0, billRequestedAt: 0, feePercent: 0,
      bookingId: booking ? String(booking.id) : "",
    });
    transaction.set(pointer, {sessionId: ref.id, restaurantId: input.restaurantId, tableId: table.id, openedAt: now});
    if (booking) transaction.update(bookingRef(String(booking.id)), {status: "seated", seatedAt: now, tableId: table.id, sessionId: ref.id, updatedAt: now});
    return {sessionId: ref.id, created: true};
  });
  if (result.created) {
    await notifyRestaurantDineIn({restaurantId: input.restaurantId, key: `table:${result.sessionId}:open`,
      title: `${table.label} is seated`, body: booking ? `${name}’s booking for ${booking.party} checked in.` : `${name} opened the table from the app.`}).catch(() => {});
  }
  return result;
}

async function memberSession(uid: string, sessionId: string): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new DomainError("invalid-argument", "Unknown table.");
  const snapshot = await sessionRef(sessionId).get();
  const session = snapshot.exists ? snapshot.data() as Record<string, unknown> : null;
  if (!session || !(Array.isArray(session.memberUids) && (session.memberUids as string[]).includes(uid))) throw new DomainError("not-found", "Table not found.");
  return session;
}

export async function placeTableRound(uid: string, input: {sessionId: string; items: Array<{itemId: string; quantity: number; variantId?: string; addOnIds?: string[]; note?: string}>}, now = Date.now()) {
  const session = await memberSession(uid, input.sessionId);
  if (session.status !== "open") throw new DomainError("failed-precondition", session.status === "bill" ? "The bill has been asked for. Ask the staff to reopen the table to order more." : "This table is closed.");
  if (Number(session.rounds || 0) >= MAX_ROUNDS) throw new DomainError("resource-exhausted", "This table has reached the round limit. Ask the staff.");
  const restaurantId = String(session.restaurantId);
  const [restaurantSnap, menuSnap] = await Promise.all([
    firestoreDb.collection("restaurants").doc(restaurantId).get(),
    firestoreDb.collection("menus").doc(restaurantId).collection("items").get(),
  ]);
  const restaurant = restaurantSnap.data() as Record<string, unknown> | undefined;
  if (!restaurant || !normalizeDineIn(restaurant.dineIn).enabled) throw new DomainError("failed-precondition", "Dine-in ordering is paused here.");
  const menuById: Record<string, CatalogItem> = {};
  menuSnap.docs.forEach((doc) => { menuById[doc.id] = {id: doc.id, ...(doc.data() as object)} as CatalogItem; });
  if (!Object.keys(menuById).length && Array.isArray(restaurant.menu)) (restaurant.menu as CatalogItem[]).forEach((item) => { if (item && item.id) menuById[item.id] = item; });
  let priced;
  try {
    priced = priceCart(input.items.map((item) => ({itemId: item.itemId, quantity: item.quantity, variantId: item.variantId, addOnIds: item.addOnIds ?? [], note: item.note ?? ""})), menuById);
  } catch (error) {
    throw new DomainError("failed-precondition", String((error as Error).message) === "ITEM_UNAVAILABLE" ? "Something in your order just ran out. Remove it and try again." : "Your order couldn’t be priced. Refresh the menu and try again.");
  }
  const member = (Array.isArray(session.members) ? session.members as Array<{uid: string; name: string}> : []).find((entry) => entry.uid === uid);
  const sessionDoc = sessionRef(input.sessionId);
  const roundRef = sessionDoc.collection("rounds").doc();
  await firestoreDb.runTransaction(async (transaction) => {
    const fresh = await transaction.get(sessionDoc);
    const data = fresh.data() as Record<string, unknown>;
    if (data.status !== "open") throw new DomainError("failed-precondition", "This table isn’t taking orders right now.");
    const totals = {...(data.memberTotals as Record<string, number> || {})};
    totals[uid] = Math.round((Number(totals[uid] || 0) + priced.subtotal) * 100) / 100;
    const number = Number(data.rounds || 0) + 1;
    transaction.set(roundRef, {id: roundRef.id, number, byUid: uid, byName: member?.name || "Guest", items: priced.items, subtotal: priced.subtotal,
      status: "sent", createdAt: now, updatedAt: now});
    transaction.update(sessionDoc, {rounds: number, subtotal: Math.round((Number(data.subtotal || 0) + priced.subtotal) * 100) / 100, memberTotals: totals, lastRoundAt: now, updatedAt: now});
  });
  await notifyRestaurantDineIn({restaurantId, key: `round:${roundRef.id}`, title: `${session.tableLabel} · new round`,
    body: priced.items.map((item) => `${item.quantity}× ${item.name}`).join(", ").slice(0, 160)}).catch(() => {});
  return {roundId: roundRef.id, subtotal: priced.subtotal};
}

export async function tableRequest(uid: string, input: {sessionId: string; kind: "waiter" | "bill"}, now = Date.now()) {
  const session = await memberSession(uid, input.sessionId);
  if (session.status !== "open" && session.status !== "bill") throw new DomainError("failed-precondition", "This table is closed.");
  const field = input.kind === "bill" ? "billRequestedAt" : "waiterCalledAt";
  if (now - Number(session[field] || 0) < 60_000) return {ok: true, repeat: true};
  const update: Record<string, unknown> = {[field]: now, updatedAt: now};
  if (input.kind === "bill") update.status = "bill";
  await sessionRef(input.sessionId).update(update);
  await notifyRestaurantDineIn({restaurantId: String(session.restaurantId), key: `table:${input.sessionId}:${input.kind}:${Math.floor(now / 60_000)}`,
    title: input.kind === "bill" ? `${session.tableLabel} asked for the bill` : `${session.tableLabel} is calling a waiter`,
    body: input.kind === "bill" ? `Food total ${Math.round(Number(session.subtotal || 0))} rupees before the restaurant’s taxes.` : "Someone at the table needs help."}).catch(() => {});
  return {ok: true};
}

// ---------------------------------------------------------------------------
// Restaurant staff actions
// ---------------------------------------------------------------------------

async function requireStaff(token: DecodedIdToken, restaurantId: string): Promise<void> {
  const allowed = await canManageRestaurantOrders(token.uid, token, restaurantId).catch(() => false);
  if (!allowed) throw new DomainError("permission-denied", "You can’t manage this restaurant’s tables.");
}

export async function dineInStaffAction(token: DecodedIdToken,
  input: {sessionId: string; action: "cooking" | "served" | "reopen" | "paid" | "close" | "ackWaiter"; roundId?: string; paidAmount?: number}, now = Date.now()) {
  const sessionDoc = sessionRef(input.sessionId);
  const snapshot = await sessionDoc.get();
  const session = snapshot.exists ? snapshot.data() as Record<string, unknown> : null;
  if (!session) throw new DomainError("not-found", "Table not found.");
  await requireStaff(token, String(session.restaurantId));
  if (input.action === "cooking" || input.action === "served") {
    if (!input.roundId) throw new DomainError("invalid-argument", "Pick a round.");
    await sessionDoc.collection("rounds").doc(input.roundId).update({status: input.action, updatedAt: now, [`${input.action}At`]: now});
    if (input.action === "served") {
      const members = Array.isArray(session.memberUids) ? session.memberUids as string[] : [];
      await Promise.all(members.map((uid) => notifyUserDineIn({uid, key: `round:${input.roundId}:served`, title: "Food’s here! 🎉",
        body: `Your round at ${session.restaurantName} has been served. Enjoy!`, data: {type: "DINE_TABLE", sessionId: input.sessionId}}).catch(() => {})));
    }
    return {ok: true};
  }
  if (input.action === "ackWaiter") { await sessionDoc.update({waiterCalledAt: 0, updatedAt: now}); return {ok: true}; }
  if (input.action === "reopen") { await sessionDoc.update({status: "open", billRequestedAt: 0, updatedAt: now}); return {ok: true}; }
  // Paid or closed: the sitting ends and the table is free again.
  const paid = input.action === "paid";
  const paidAmount = Math.max(0, Math.round(Number(input.paidAmount || session.subtotal || 0)));
  await firestoreDb.runTransaction(async (transaction) => {
    transaction.update(sessionDoc, {status: paid ? "paid" : "closed", closedAt: now, updatedAt: now, ...(paid ? {paidAmount} : {})});
    const pointer = tablePointerRef(String(session.restaurantId), String(session.tableId));
    const current = await transaction.get(pointer);
    if (current.exists && (current.data() as Record<string, unknown>).sessionId === input.sessionId) transaction.delete(pointer);
    if (session.bookingId) transaction.update(bookingRef(String(session.bookingId)), {status: "completed", updatedAt: now});
  });
  if (paid) {
    const members = Array.isArray(session.memberUids) ? session.memberUids as string[] : [];
    await Promise.all(members.map((uid) => notifyUserDineIn({uid, key: `table:${input.sessionId}:paid`, title: "Thanks for dining in 💙",
      body: `Bill settled at ${session.restaurantName}. Hope you loved it!`, data: {type: "DINE_TABLE", sessionId: input.sessionId}}).catch(() => {})));
  }
  return {ok: true};
}

// ---------------------------------------------------------------------------
// The watch: reminders, no-shows, stale tables (every 10 minutes)
// ---------------------------------------------------------------------------

export async function watchDineIn(now = Date.now()): Promise<{reminded: number; noShows: number; closed: number}> {
  let reminded = 0; let noShows = 0; let closed = 0;
  const upcoming = await firestoreDb.collection("dineBookings").where("status", "==", "confirmed")
    .where("slotAt", ">=", now - 6 * 60 * 60 * 1000).where("slotAt", "<=", now + 2.25 * 60 * 60 * 1000).get();
  for (const doc of upcoming.docs) {
    const booking = doc.data() as Record<string, unknown>;
    const slotAt = Number(booking.slotAt);
    const left = slotAt - now;
    if (left <= -HOLD_MINUTES * 60_000) {
      await doc.ref.update({status: "noshow", updatedAt: now});
      await recordMiss(String(booking.customerId), doc.id, now);
      noShows++;
      await notifyRestaurantDineIn({restaurantId: String(booking.restaurantId), key: `booking:${doc.id}:noshow`, title: "Table released",
        body: `${booking.customerName} (${booking.party} people, ${slotLabel(slotAt)}) didn’t arrive in ${HOLD_MINUTES} minutes.`}).catch(() => {});
      continue;
    }
    const kind = left <= 35 * 60_000 && left > 0 && booking.remindedShort !== true ? "short"
      : left <= 2.1 * 60 * 60 * 1000 && left > 35 * 60_000 && booking.remindedLong !== true ? "long" : "";
    if (!kind) continue;
    await doc.ref.update(kind === "short" ? {remindedShort: true, remindedLong: true} : {remindedLong: true});
    await notifyUserDineIn({uid: String(booking.customerId), key: `booking:${doc.id}:remind:${kind}`,
      title: kind === "short" ? "Your table is almost ready" : "Table booked for today",
      body: `${booking.restaurantName} at ${slotLabel(slotAt)} for ${booking.party}. Scan the table QR when you sit down.${kind === "long" ? " Can’t make it? Cancel free up to an hour before." : ""}`,
      data: {type: "DINE_BOOKING", bookingId: doc.id}}).catch(() => {});
    reminded++;
  }
  const stale = await firestoreDb.collection("tableSessions").where("status", "in", ["open", "bill"]).where("openedAt", "<=", now - SESSION_MAX_AGE_MS).limit(50).get();
  for (const doc of stale.docs) {
    const session = doc.data() as Record<string, unknown>;
    await doc.ref.update({status: "closed", closedAt: now, autoClosed: true, updatedAt: now});
    await tablePointerRef(String(session.restaurantId), String(session.tableId)).delete().catch(() => {});
    closed++;
  }
  if (reminded || noShows || closed) logger.info("DINE_IN_WATCH", {reminded, noShows, closed});
  return {reminded, noShows, closed};
}
