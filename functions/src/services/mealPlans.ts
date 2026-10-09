import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {DomainError} from "../errors";
import {menuItemsCollectionRef, orderRef, restaurantRef} from "../firestorePaths";
import {createOrderSchema} from "../schemas";
import type {CatalogItem, CatalogRestaurant} from "../types";
import {canManageRestaurantOrders} from "./authz";
import {loadCustomerAddress} from "./catalog";
import {createAuthoritativeOrder} from "./orders";

/**
 * Daily meal plans (tiffin): a restaurant offers one dish as a lunch, dinner
 * or breakfast plan on chosen days; customers subscribe, skip days and pause.
 * Each day, ahead of the delivery window, the plan turns into an ordinary
 * cash-on-delivery order for every active subscriber, so the restaurant,
 * rider, tracking and bill work exactly as for any other order. The meal is
 * charged at the dish's menu price.
 */

type Rec = Record<string, unknown>;
export type Meal = "breakfast" | "lunch" | "dinner";

/** Orders are placed this long before the delivery window opens. */
export const ORDER_LEAD_MIN = 45;
/** How long after that moment a missed scheduler run may still place the order. */
const CATCH_UP_MIN = 40;
const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const plans = () => firestoreDb.collection("mealPlans");
const subscriptions = () => firestoreDb.collection("mealSubscriptions");

export interface MealPlanInput {
  planId?: string; restaurantId: string; name: string; description: string; meal: Meal; menuItemId: string;
  days: number[]; windowStart: string; windowEnd: string; weeklyMenu: Record<string, string>; maxPerDay: number; active: boolean;
}

/** India time: the calendar date, weekday (0 = Sunday) and minutes since midnight. */
export function istParts(at: number): {date: string; weekday: number; minutes: number} {
  const d = new Date(at + IST_MS);
  return {date: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes()};
}

export function toMinutes(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The moment (ms) a plan's order for `date` is placed; skipping closes then. */
export function orderTimeFor(date: string, windowStart: string): number {
  return Date.parse(`${date}T00:00:00+05:30`) + (toMinutes(windowStart) - ORDER_LEAD_MIN) * 60_000;
}

export function weekdayOf(date: string): number {
  return new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function validatePlan(input: MealPlanInput): void {
  const start = toMinutes(input.windowStart), end = toMinutes(input.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 30 || end - start > 180) {
    throw new DomainError("invalid-argument", "Set a delivery window of 30 minutes to 3 hours, like 12:30 to 13:30.");
  }
  if (start - ORDER_LEAD_MIN < 6 * 60) throw new DomainError("invalid-argument", "The delivery window must start after 6:45 am.");
  const days = [...new Set(input.days)];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new DomainError("invalid-argument", "Choose at least one day.");
  }
  if (input.maxPerDay < 1 || input.maxPerDay > 500) throw new DomainError("invalid-argument", "Meals per day must be 1 to 500.");
}

/** Does this subscription get a meal on `date`? */
export function dueOn(sub: Rec, date: string): boolean {
  if (sub.status !== "active") return false;
  if (date < String(sub.startDate ?? "")) return false;
  if (sub.endDate && date > String(sub.endDate)) return false;
  if (!(sub.days as number[] | undefined)?.includes(weekdayOf(date))) return false;
  return !(sub.skips as string[] | undefined)?.includes(date);
}

/** The next dates (up to `count`) this subscription will be delivered, from `fromDate`. */
export function upcomingDates(sub: Rec, fromDate: string, count = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < 60 && out.length < count; i++) {
    const date = addDays(fromDate, i);
    if (sub.endDate && date > String(sub.endDate)) break;
    if (date >= String(sub.startDate ?? "") && (sub.days as number[]).includes(weekdayOf(date))) out.push(date);
  }
  return out;
}

async function loadRestaurantMenuItem(restaurantId: string, menuItemId: string): Promise<{restaurant: CatalogRestaurant; item: CatalogItem}> {
  const [restaurantSnap, menuSnap] = await Promise.all([restaurantRef(firestoreDb, restaurantId).get(), menuItemsCollectionRef(firestoreDb, restaurantId).get()]);
  const restaurant = (restaurantSnap.exists ? restaurantSnap.data() : null) as CatalogRestaurant | null;
  if (!restaurant) throw new DomainError("not-found", "Restaurant not found.");
  const normalized = menuSnap.docs.map((doc) => ({id: doc.id, ...(doc.data() as object)} as CatalogItem));
  const embedded = Array.isArray(restaurant.menu) ? restaurant.menu as CatalogItem[] : Object.values((restaurant.menu ?? {}) as Record<string, CatalogItem>);
  const item = (normalized.length ? normalized : embedded).find((x) => x && x.id === menuItemId);
  if (!item) throw new DomainError("not-found", "Choose a dish from your menu for this plan.");
  return {restaurant, item};
}

// ---------------------------------------------------------------- restaurant

export async function saveMealPlan(uid: string, token: DecodedIdToken, input: MealPlanInput, now = Date.now()) {
  if (!await canManageRestaurantOrders(uid, token, input.restaurantId)) {
    throw new DomainError("permission-denied", "Only this restaurant's staff can manage its meal plans.");
  }
  validatePlan(input);
  const {restaurant, item} = await loadRestaurantMenuItem(input.restaurantId, input.menuItemId);
  const r = restaurant as unknown as Rec, it = item as unknown as Rec;
  const ref = input.planId ? plans().doc(input.planId) : plans().doc();
  if (input.planId) {
    const existing = await ref.get();
    if (!existing.exists || (existing.data() as Rec).restaurantId !== input.restaurantId) throw new DomainError("not-found", "Meal plan not found.");
  }
  const weeklyMenu: Record<string, string> = {};
  for (const [day, text] of Object.entries(input.weeklyMenu ?? {})) {
    if (/^[0-6]$/.test(day) && String(text).trim()) weeklyMenu[day] = String(text).trim().slice(0, 160);
  }
  const plan = {
    id: ref.id, restaurantId: input.restaurantId, restaurantName: String(restaurant.name ?? ""), area: String(r.area ?? restaurant.city ?? ""),
    city: String(restaurant.city ?? ""), name: input.name.trim().slice(0, 60), description: input.description.trim().slice(0, 240), meal: input.meal,
    menuItemId: item.id, menuItemName: String(item.name ?? ""), price: Number(item.price ?? 0), veg: it.veg === true || it.isVeg === true,
    imageUrl: String(it.imageUrl ?? it.image ?? ""), days: [...new Set(input.days)].sort(), windowStart: input.windowStart,
    windowEnd: input.windowEnd, weeklyMenu, maxPerDay: input.maxPerDay, active: input.active, updatedAt: now, updatedBy: uid,
    ...(input.planId ? {} : {createdAt: now}),
  };
  await ref.set(plan, {merge: true});
  return {planId: ref.id};
}

export async function getRestaurantMealPlans(uid: string, token: DecodedIdToken, restaurantId: string, now = Date.now()) {
  if (!await canManageRestaurantOrders(uid, token, restaurantId)) {
    throw new DomainError("permission-denied", "Only this restaurant's staff can see its meal plans.");
  }
  const [planSnap, subSnap] = await Promise.all([
    plans().where("restaurantId", "==", restaurantId).get(),
    subscriptions().where("restaurantId", "==", restaurantId).where("status", "==", "active").get(),
  ]);
  const today = istParts(now).date, tomorrow = addDays(today, 1);
  const subs = subSnap.docs.map((d) => d.data() as Rec);
  return {
    plans: planSnap.docs.map((d) => {
      const plan = d.data() as Rec;
      const mine = subs.filter((s) => s.planId === d.id);
      const meals = (date: string) => mine.filter((s) => dueOn(s, date)).reduce((n, s) => n + Number(s.quantity ?? 1), 0);
      return {...plan, subscribers: mine.length, mealsToday: meals(today), mealsTomorrow: meals(tomorrow)};
    }),
  };
}

// ------------------------------------------------------------------ customer

export async function subscribeMealPlan(uid: string, input: {planId: string; addressId: string; startDate: string; days: number[]; quantity: number; weeks: number}, now = Date.now()) {
  const planSnap = await plans().doc(input.planId).get();
  const plan = (planSnap.exists ? planSnap.data() : null) as Rec | null;
  if (!plan || plan.active !== true) throw new DomainError("failed-precondition", "This meal plan isn't taking new members right now.");
  const days = [...new Set(input.days)].filter((d) => (plan.days as number[]).includes(d)).sort();
  if (!days.length) throw new DomainError("invalid-argument", "Choose at least one day this plan delivers.");
  const today = istParts(now).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || input.startDate < today || input.startDate > addDays(today, 30)) {
    throw new DomainError("invalid-argument", "Start within the next 30 days.");
  }
  if (input.startDate === today && now >= orderTimeFor(today, String(plan.windowStart))) {
    throw new DomainError("failed-precondition", "Today's meal is already being prepared. Start from tomorrow.");
  }
  if (input.quantity < 1 || input.quantity > 5) throw new DomainError("invalid-argument", "Choose 1 to 5 meals a day.");
  if (![0, 1, 2, 4].includes(input.weeks)) throw new DomainError("invalid-argument", "Choose 1, 2 or 4 weeks, or until you stop.");
  const {address, profile} = await loadCustomerAddress(uid, input.addressId);

  const active = await subscriptions().where("planId", "==", input.planId).where("status", "==", "active").get();
  const taken = active.docs.filter((d) => (d.data() as Rec).customerId !== uid).reduce((n, d) => n + Number((d.data() as Rec).quantity ?? 1), 0);
  if (taken + input.quantity > Number(plan.maxPerDay ?? 0)) throw new DomainError("resource-exhausted", "This plan is full. Try fewer meals or another plan.");

  const id = `${uid}_${input.planId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
  const ref = subscriptions().doc(id);
  const existing = await ref.get();
  if (existing.exists && ["active", "paused"].includes(String((existing.data() as Rec).status))) {
    throw new DomainError("already-exists", "You already have this plan. Change it from My meal plans.");
  }
  const endDate = input.weeks ? addDays(input.startDate, input.weeks * 7 - 1) : "";
  const sub = {
    id, customerId: uid, customerName: String(profile.name ?? "").slice(0, 80), planId: input.planId, restaurantId: String(plan.restaurantId),
    restaurantName: String(plan.restaurantName ?? ""), planName: String(plan.name ?? ""), meal: String(plan.meal ?? "lunch"),
    windowStart: String(plan.windowStart), windowEnd: String(plan.windowEnd), price: Number(plan.price ?? 0), days, quantity: input.quantity,
    addressId: address.id, addressLabel: `${address.label} · ${address.area}`.slice(0, 160), startDate: input.startDate, endDate, skips: [],
    paymentMethod: "cod", status: "active", delivered: 0, createdAt: now, updatedAt: now,
  };
  await ref.set(sub);
  return {subscriptionId: id, next: upcomingDates(sub, input.startDate, 3)};
}

export async function updateMealSubscription(uid: string, input: {subscriptionId: string; action: "skip" | "unskip" | "pause" | "resume" | "cancel"; date?: string}, now = Date.now()) {
  const ref = subscriptions().doc(input.subscriptionId);
  const snap = await ref.get();
  const sub = (snap.exists ? snap.data() : null) as Rec | null;
  if (!sub || sub.customerId !== uid) throw new DomainError("not-found", "Meal plan not found.");
  if (["cancelled", "ended"].includes(String(sub.status))) throw new DomainError("failed-precondition", "This meal plan has ended.");
  const skips = new Set((sub.skips as string[] | undefined) ?? []);
  const today = istParts(now).date;
  if (input.action === "skip" || input.action === "unskip") {
    const date = String(input.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) throw new DomainError("invalid-argument", "Choose a day that hasn't passed.");
    if (now >= orderTimeFor(date, String(sub.windowStart))) {
      throw new DomainError("failed-precondition", "That meal is already with the restaurant. You can change days after it.");
    }
    if (input.action === "skip") skips.add(date); else skips.delete(date);
    for (const d of [...skips]) if (d < today) skips.delete(d);
    await ref.set({skips: [...skips].sort(), updatedAt: now}, {merge: true});
  } else if (input.action === "pause") {
    await ref.set({status: "paused", pausedAt: now, updatedAt: now}, {merge: true});
  } else if (input.action === "resume") {
    if (sub.status !== "paused") throw new DomainError("failed-precondition", "This meal plan isn't paused.");
    await ref.set({status: "active", updatedAt: now}, {merge: true});
  } else {
    await ref.set({status: "cancelled", cancelledAt: now, updatedAt: now}, {merge: true});
  }
  return {subscriptionId: input.subscriptionId};
}

// ----------------------------------------------------------------- scheduler

/** Is it time to place today's orders for a plan (and not too late to catch up)? */
export function planDueNow(plan: Rec, now: number): string | null {
  const {date, weekday} = istParts(now);
  if (plan.active !== true || !(plan.days as number[] | undefined)?.includes(weekday)) return null;
  const at = orderTimeFor(date, String(plan.windowStart));
  return now >= at && now < at + CATCH_UP_MIN * 60_000 ? date : null;
}

/** Every few minutes: turn today's meal plans into orders, once per subscriber per day. */
export async function placeDueMealOrders(now = Date.now()): Promise<{placed: number; failed: number}> {
  const live = await plans().where("active", "==", true).get();
  let placed = 0, failed = 0;
  for (const planDoc of live.docs) {
    const plan = planDoc.data() as Rec;
    const date = planDueNow(plan, now);
    if (!date) continue;
    const subs = await subscriptions().where("planId", "==", planDoc.id).where("status", "==", "active").get();
    for (const subDoc of subs.docs) {
      const sub = subDoc.data() as Rec;
      if (sub.endDate && date > String(sub.endDate)) {
        await subDoc.ref.set({status: "ended", updatedAt: now}, {merge: true});
        continue;
      }
      if (!dueOn(sub, date) || sub.lastOrderDate === date) continue;
      try {
        const input = createOrderSchema.parse({
          idempotencyKey: `meal_${subDoc.id}_${date.replace(/-/g, "")}`.replace(/[^A-Za-z0-9_-]/g, "").slice(-80),
          restaurantId: String(plan.restaurantId),
          items: [{itemId: String(plan.menuItemId), quantity: Number(sub.quantity ?? 1)}],
          addressId: String(sub.addressId),
          instructions: `Meal plan: ${String(plan.name ?? "")}`.slice(0, 500),
          paymentMethod: "cod",
        });
        const {order} = await createAuthoritativeOrder(String(sub.customerId), input);
        await orderRef(firestoreDb, order.id).set({mealPlan: {planId: planDoc.id, subscriptionId: subDoc.id, date, name: String(plan.name ?? "")}}, {merge: true});
        await subDoc.ref.set({lastOrderDate: date, lastOrderId: order.id, delivered: Number(sub.delivered ?? 0) + 1, lastError: "", updatedAt: now}, {merge: true});
        placed++;
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message.slice(0, 200) : "unknown";
        logger.warn("MEAL_PLAN_ORDER_FAILED", {subscriptionId: subDoc.id, date, error: message});
        await subDoc.ref.set({lastOrderDate: date, lastError: message, lastErrorAt: now, updatedAt: now}, {merge: true});
      }
    }
  }
  if (placed || failed) logger.info("MEAL_PLAN_ORDERS", {placed, failed});
  return {placed, failed};
}
