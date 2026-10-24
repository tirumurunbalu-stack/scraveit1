import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {notifyCartReminder} from "./notifications";

/**
 * The next-day nudge about a cart a customer left.
 *
 * The first reminder comes from the phone itself about 5 seconds after they
 * leave the app (CartNudge.java in the Customer app, at most one a day). The
 * app also keeps users/{uid}.cartSnapshot up to date (store, first item, item
 * count, when it last changed) and clears it when the cart empties or the
 * order is placed. If the cart is still sitting there 20 to 26 hours later,
 * this sends one follow-up, between 8 am and 10 pm, then no more for that
 * cart. At most three a week per person, nothing if the store is closed, the
 * person has ordered since, turned reminders or notifications off, or is
 * under 18 (no behavioural marketing to children, DPDP Act, 2023, s.9(3)).
 */

type Rec = Record<string, unknown>;
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const FOLLOW_UP_AFTER = 20 * HOUR;
export const GIVE_UP_AFTER = 26 * HOUR;
export const WEEKLY_CAP = 3;

export interface CartSnapshot {
  restaurantId: string;
  restaurantName: string;
  storeType: string;
  itemCount: number;
  firstItem: string;
  subtotal: number;
  updatedAt: number;
}

/** Hour of day in India (UTC+5:30). */
export function istHour(now: number): number {
  return new Date(now + 5.5 * HOUR).getUTCHours();
}

function clean(text: unknown, max: number): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The words of the follow-up, by store type. */
export function cartReminderCopy(cart: CartSnapshot): {title: string; body: string} {
  const item = clean(cart.firstItem, 40) || "your items";
  const store = clean(cart.restaurantName, 40) || "the store";
  const more = cart.itemCount > 1 ? ` and ${cart.itemCount - 1} more` : "";
  const what = `${item}${more}`;
  if (cart.storeType === "dairy") return {title: "🥛 Still need your dairy?", body: `${what} from ${store} is saved in your cart. Fresh delivery is a tap away 🐄`};
  if (cart.storeType === "grocery") return {title: "🧺 Your basket is still here", body: `${what} from ${store} is waiting. Finish your order in a tap 🛒`};
  return {title: `👀 Still thinking about ${item}?`, body: `Your cart at ${store} is saved. Order it before you get hangry 😋`};
}

/** Whether this cart is due its follow-up now. */
export function reminderDue(cart: CartSnapshot | null, sent: Rec | null, recentTimes: number[], now: number): boolean {
  if (!cart || !cart.restaurantId || !(cart.itemCount > 0)) return false;
  const age = now - Number(cart.updatedAt || 0);
  if (age < FOLLOW_UP_AFTER || age > GIVE_UP_AFTER) return false;
  const hour = istHour(now);
  if (hour < 8 || hour >= 22) return false;
  if (recentTimes.filter((t) => now - t < 7 * DAY).length >= WEEKLY_CAP) return false;
  return !(sent && Number(sent.for) === Number(cart.updatedAt));
}

export async function runCartReminders(now = Date.now()): Promise<number> {
  const due = await firestoreDb.collection("users")
    .where("cartSnapshot.updatedAt", ">=", now - GIVE_UP_AFTER)
    .where("cartSnapshot.updatedAt", "<=", now - FOLLOW_UP_AFTER)
    .limit(300).get();
  let sent = 0;
  for (const user of due.docs) {
    const data = user.data() as Rec;
    const cart = (data.cartSnapshot ?? null) as CartSnapshot | null;
    const prefs = (data.preferences ?? {}) as Rec;
    if (prefs.notifications === false || prefs.cartReminders === false) continue;
    const recent = Array.isArray(data.cartReminderTimes) ? (data.cartReminderTimes as unknown[]).map(Number).filter(Number.isFinite) : [];
    if (!cart || !reminderDue(cart, (data.cartReminder ?? null) as Rec | null, recent, now)) continue;
    try {
      const [age, store, orders] = await Promise.all([
        firestoreDb.collection("accountAges").doc(user.id).get(),
        firestoreDb.collection("restaurants").doc(cart.restaurantId).get(),
        firestoreDb.collection("orders").where("customerId", "==", user.id).get(),
      ]);
      if (age.exists && age.data()?.minor === true) continue;
      if (!store.exists || store.data()?.open === false) continue;
      if (orders.docs.some((o) => Number(o.data().createdAt ?? 0) > Number(cart.updatedAt))) {
        await user.ref.set({cartSnapshot: null}, {merge: true});
        continue;
      }
      const copy = cartReminderCopy(cart);
      await notifyCartReminder({uid: user.id, key: `cart:${user.id}:${cart.updatedAt}`, title: copy.title, body: copy.body});
      await user.ref.set({
        cartReminder: {for: cart.updatedAt, count: 1, lastAt: now},
        cartReminderTimes: [...recent.filter((t) => now - t < 7 * DAY), now].slice(-WEEKLY_CAP),
      }, {merge: true});
      sent++;
    } catch (error) {
      logger.warn("CART_REMINDER_FAILED", {uid: user.id, error: String(error)});
    }
  }
  return sent;
}
