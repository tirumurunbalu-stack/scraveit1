import type {DecodedIdToken} from "firebase-admin/auth";
import {firestoreDb} from "../admin";
import type {FirestoreLike} from "../firestoreTypes";
import {ORDER_ECONOMICS_COLLECTION} from "./economics";
import {requirePlatformConfigAdminClaim} from "./authz";

/**
 * The owner's "today at a glance": business numbers in plain words, worked
 * out on the server from the orders and their locked money records, never
 * from a bounded client-side window.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ORDERS = 3_000;
const COOKING = new Set(["Accepted", "Preparing"]);
const ON_THE_WAY = new Set(["Assigned", "Handed to rider", "Out for delivery", "Near you", "Arrived"]);

export type StoreKind = "restaurant" | "grocery" | "dairy";

export interface PeriodTotals {
  orders: number;
  delivered: number;
  cancelled: number;
  salesPaise: number;
  earnedPaise: number;
  storesEarnedPaise: number;
  ridersEarnedPaise: number;
  avgDeliveryMinutes: number | null;
}

export interface AdminToday {
  generatedAt: number;
  days: number;
  periodStart: number;
  all: PeriodTotals;
  byKind: Record<StoreKind, PeriodTotals>;
  /** The same stretch of time one week earlier, for "▲ 12%". */
  lastWeek: PeriodTotals;
  lastWeekByKind: Record<StoreKind, PeriodTotals>;
  live: {placed: number; cooking: number; waitingForRider: number; onTheWay: number};
  fssaiExpiring: Array<{restaurantId: string; name: string; expiresOn: string; days: number}>;
}

/** Midnight in India for the day `at` falls on, as epoch milliseconds. */
export function istDayStart(at: number): number {
  return Math.floor((at + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

function emptyTotals(): PeriodTotals {
  return {orders: 0, delivered: 0, cancelled: 0, salesPaise: 0, earnedPaise: 0, storesEarnedPaise: 0, ridersEarnedPaise: 0, avgDeliveryMinutes: null};
}

type Rec = Record<string, unknown>;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? v as Rec : {});

export function summarize(
  orders: Rec[],
  economicsByOrder: Map<string, Rec>,
  kindOf: (restaurantId: string) => StoreKind,
): {all: PeriodTotals; byKind: Record<StoreKind, PeriodTotals>} {
  const all = emptyTotals();
  const byKind: Record<StoreKind, PeriodTotals> = {restaurant: emptyTotals(), grocery: emptyTotals(), dairy: emptyTotals()};
  const minutes: Record<string, number[]> = {all: [], restaurant: [], grocery: [], dairy: []};
  for (const order of orders) {
    const kind = kindOf(String(order.restaurantId ?? ""));
    const targets = [all, byKind[kind]];
    const status = String(order.status ?? "");
    const pricing = rec(order.pricing);
    const snapshot = rec(rec(economicsByOrder.get(String(order.id ?? ""))).snapshot);
    for (const t of targets) {
      t.orders++;
      if (status === "Cancelled") { t.cancelled++; continue; }
      t.salesPaise += Math.round(num(pricing.subtotal) * 100);
      if (status === "Delivered") {
        t.delivered++;
        t.earnedPaise += num(rec(snapshot.platform).contributionPaise);
        t.storesEarnedPaise += num(rec(snapshot.restaurant).receivablePaise);
        t.ridersEarnedPaise += num(rec(snapshot.rider).totalPaise);
      }
    }
    if (status === "Delivered" && num(order.deliveredAt) > num(order.createdAt)) {
      const m = (num(order.deliveredAt) - num(order.createdAt)) / 60_000;
      if (m > 0 && m < 240) { minutes.all!.push(m); minutes[kind]!.push(m); }
    }
  }
  const avg = (list: number[]) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
  all.avgDeliveryMinutes = avg(minutes.all!);
  for (const k of ["restaurant", "grocery", "dairy"] as StoreKind[]) byKind[k].avgDeliveryMinutes = avg(minutes[k]!);
  return {all, byKind};
}

async function ordersBetween(database: FirestoreLike, from: number, to: number): Promise<Rec[]> {
  const snapshot = await database.collection("orders").where("createdAt", ">=", from).where("createdAt", "<", to)
    .orderBy("createdAt", "desc").limit(MAX_ORDERS).get();
  return snapshot.docs.map((doc) => ({id: doc.id, ...(doc.data() as Rec)}));
}

async function economicsFor(database: FirestoreLike, from: number, to: number): Promise<Map<string, Rec>> {
  const snapshot = await database.collection(ORDER_ECONOMICS_COLLECTION).where("createdAt", ">=", from).where("createdAt", "<", to)
    .limit(MAX_ORDERS).get();
  return new Map(snapshot.docs.map((doc) => [doc.id, doc.data() as Rec]));
}

export async function readAdminToday(
  token: DecodedIdToken,
  input: {days: number},
  database: FirestoreLike = firestoreDb,
  now = Date.now(),
): Promise<AdminToday> {
  requirePlatformConfigAdminClaim(token);
  const days = [1, 7, 30].includes(input.days) ? input.days : 1;
  const start = istDayStart(now) - (days - 1) * DAY_MS;
  const weekAgo = 7 * DAY_MS;
  const [orders, economics, previous, previousEconomics, restaurants, active] = await Promise.all([
    ordersBetween(database, start, now + 1),
    economicsFor(database, start, now + 1),
    ordersBetween(database, start - weekAgo, now - weekAgo + 1),
    economicsFor(database, start - weekAgo, now - weekAgo + 1),
    database.collection("restaurants").get(),
    database.collection("orders").where("status", "in", ["Order placed", "Accepted", "Preparing", "Ready for pickup",
      "Assigned", "Handed to rider", "Out for delivery", "Near you", "Arrived"]).limit(500).get(),
  ]);
  const kinds = new Map<string, StoreKind>();
  const fssaiExpiring: AdminToday["fssaiExpiring"] = [];
  const today = istDayStart(now);
  for (const doc of restaurants.docs) {
    const r = doc.data() as Rec;
    const type = String(r.storeType ?? "restaurant");
    kinds.set(doc.id, type === "grocery" || type === "dairy" ? type : "restaurant");
    const expires = String(r.fssaiExpiresOn ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(expires) && r.archived !== true) {
      const left = Math.round((Date.parse(`${expires}T00:00:00+05:30`) - today) / DAY_MS);
      if (left <= 30) fssaiExpiring.push({restaurantId: doc.id, name: String(r.name ?? doc.id), expiresOn: expires, days: left});
    }
  }
  const kindOf = (id: string) => kinds.get(id) ?? "restaurant";
  const current = summarize(orders, economics, kindOf);
  const before = summarize(previous, previousEconomics, kindOf);
  const live = {placed: 0, cooking: 0, waitingForRider: 0, onTheWay: 0};
  for (const doc of active.docs) {
    const o = doc.data() as Rec;
    const status = String(o.status ?? "");
    if (status === "Order placed") live.placed++;
    else if (COOKING.has(status)) live.cooking++;
    else if (status === "Ready for pickup" && !o.riderId) live.waitingForRider++;
    else if (ON_THE_WAY.has(status) || status === "Ready for pickup") live.onTheWay++;
  }
  return {
    generatedAt: now, days, periodStart: start,
    all: current.all, byKind: current.byKind, lastWeek: before.all, lastWeekByKind: before.byKind,
    live, fssaiExpiring: fssaiExpiring.sort((a, b) => a.days - b.days).slice(0, 50),
  };
}

export interface StorePayoutDue {
  restaurantId: string;
  name: string;
  pendingPaise: number;
  needsReview: boolean;
}

/**
 * Stores with money waiting for their payout, from the same ledger-checked
 * settlement summary the payout screen uses. A store whose ledger can't be
 * fully verified is listed as "needs review" rather than given a number.
 */
export async function readStorePayoutsDue(
  uid: string,
  token: DecodedIdToken,
  database: FirestoreLike = firestoreDb,
  summaryFor: (restaurantId: string) => Promise<{pendingSettlementPaise: number | null; requiresFinanceReview: boolean;
    automation?: {minimumSettlementPaise: number}}> = async (restaurantId) =>
    (await import("./restaurantSettlements")).getRestaurantSettlementSummary(uid, token, {restaurantId, historyLimit: 1}),
): Promise<{stores: StorePayoutDue[]; checked: number}> {
  requirePlatformConfigAdminClaim(token);
  const restaurants = await database.collection("restaurants").get();
  const live = restaurants.docs.filter((doc) => (doc.data() as Rec).archived !== true).slice(0, 40);
  const results = await Promise.all(live.map(async (doc) => {
    try {
      const summary = await summaryFor(doc.id);
      const pending = summary.pendingSettlementPaise;
      const minimum = summary.automation?.minimumSettlementPaise ?? 0;
      if (summary.requiresFinanceReview || pending === null) {
        return {restaurantId: doc.id, name: String((doc.data() as Rec).name ?? doc.id), pendingPaise: 0, needsReview: true};
      }
      return pending > 0 && pending >= minimum ?
        {restaurantId: doc.id, name: String((doc.data() as Rec).name ?? doc.id), pendingPaise: pending, needsReview: false} : null;
    } catch {
      return {restaurantId: doc.id, name: String((doc.data() as Rec).name ?? doc.id), pendingPaise: 0, needsReview: true};
    }
  }));
  const stores = results.filter((x): x is StorePayoutDue => Boolean(x))
    .sort((a, b) => Number(a.needsReview) - Number(b.needsReview) || b.pendingPaise - a.pendingPaise);
  return {stores, checked: live.length};
}
