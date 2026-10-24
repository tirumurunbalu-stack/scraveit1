import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {notifyMealSuggestion} from "./notifications";

/**
 * A food idea at breakfast (8 am), lunch (12:30 pm) and dinner (7:30 pm), the
 * way Swiggy and Zomato nudge people who haven't opened the app.
 *
 * Sent only when a store in the customer's town is open (a favourite one is
 * named if it is), and never to someone who ordered in the last 3 hours, got a
 * cart reminder in the last 3 hours, switched meal-time suggestions or
 * notifications off, or is under 18 (no marketing to children, DPDP Act,
 * 2023, s.9(3)). One per meal per day: the outbox de-duplicates on the date.
 */

type Rec = Record<string, unknown>;
export type MealSlot = "breakfast" | "lunch" | "dinner";
const HOUR = 60 * 60 * 1000, QUIET_AFTER_ORDER = 3 * HOUR;

interface Store {id: string; name: string; city: string; kind: "restaurant" | "grocery" | "dairy"}

const COPY: Record<MealSlot, Array<{title: string; body: string}>> = {
  breakfast: [
    {title: "☀️ Good morning! Idli, dosa or pesarattu?", body: "Hot breakfast from stores near you, delivered fresh. Tap to order 😋"},
    {title: "☕ Chai and something crispy?", body: "Vada, upma, poori… breakfast near you is one tap away 😉"},
    {title: "🍳 Skip the cooking today", body: "Breakfast is open near you. Start the day with something tasty 😋"},
  ],
  lunch: [
    {title: "🍛 Lunch o'clock!", body: "Biryani, meals or something light? Order now and eat soon 🤤"},
    {title: "😋 Hungry yet?", body: "Your lunch break deserves better. See what's cooking near you 🍽️"},
    {title: "🌶️ Meals ready, plate waiting", body: "Andhra meals, biryani and more are open near you. Tap to order 😋"},
  ],
  dinner: [
    {title: "🌙 Dinner sorted?", body: "Don't cook tonight. Order from stores near you and relax 😌"},
    {title: "🍕 What's for dinner?", body: "Biryani, pizza, parotta… your favourites are open now 🤤"},
    {title: "🍽️ Dinner time!", body: "See what's hot near you tonight and order in a tap 🔥"},
  ],
};
const FAVOURITE: Record<MealSlot, (store: string) => {title: string; body: string}> = {
  breakfast: (store) => ({title: "☀️ Breakfast from " + store + "?", body: `${store} is open now. Your favourite is one tap away 😋`}),
  lunch: (store) => ({title: "🍛 Lunch from " + store + "?", body: `${store} is open now. Order your usual in a tap 🤤`}),
  dinner: (store) => ({title: "🌙 Dinner from " + store + "?", body: `${store} is open now. Treat yourself tonight 😋`}),
};
const DAIRY_MORNING = {title: "🥛 Fresh milk for the morning?", body: "Milk, curd and paneer from dairies near you, delivered fresh 🐄"};

function key(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function storeKind(data: Rec): Store["kind"] {
  const type = key(data.storeType), category = key(data.category);
  if (type === "grocery" || type === "dairy") return type;
  if (!type && category === "dairy") return "dairy";
  if (!type && (category === "grocery" || category === "groceries")) return "grocery";
  return "restaurant";
}

/** The town of the address the customer has selected (or their first one). */
export function customerTown(profile: Rec): string {
  const addresses = Array.isArray(profile.addresses) ? profile.addresses as Rec[] : [];
  const current = addresses.find((a) => a && a.id === profile.selectedAddressId) ?? addresses[0];
  return current ? key(current.city || current.area) : "";
}

/** What to send this customer for this meal, or null to send nothing. */
export function mealSuggestionFor(slot: MealSlot, profile: Rec, openStores: Store[], dayNumber: number): {title: string; body: string} | null {
  const town = customerTown(profile);
  // A store with no town set is shown to everyone, as in the app.
  const near = openStores.filter((s) => !town || !s.city || s.city === town);
  const food = near.filter((s) => s.kind === "restaurant");
  const favourites = new Set((Array.isArray(profile.favourites) ? profile.favourites : []).map(String));
  const favourite = food.find((s) => favourites.has(s.id));
  if (favourite) return FAVOURITE[slot](favourite.name.slice(0, 40));
  if (food.length) {
    const options = COPY[slot];
    return options[((dayNumber % options.length) + options.length) % options.length] ?? null;
  }
  if (slot === "breakfast" && near.some((s) => s.kind === "dairy")) return DAIRY_MORNING;
  return null;
}

export async function runMealSuggestions(slot: MealSlot, now = Date.now()): Promise<number> {
  const [stores, users, minors, recentOrders] = await Promise.all([
    firestoreDb.collection("restaurants").get(),
    firestoreDb.collection("users").get(),
    firestoreDb.collection("accountAges").where("minor", "==", true).get(),
    firestoreDb.collection("orders").where("createdAt", ">=", now - QUIET_AFTER_ORDER).get(),
  ]);
  const openStores: Store[] = stores.docs
    .map((doc) => ({doc, data: doc.data() as Rec}))
    .filter(({data}) => data.open !== false && data.acceptingOrders !== false && String(data.name ?? "").trim())
    .map(({doc, data}) => ({id: doc.id, name: String(data.name).trim(), city: key(data.city), kind: storeKind(data)}));
  if (!openStores.length) return 0;
  const skip = new Set([...minors.docs.map((d) => d.id), ...recentOrders.docs.map((d) => String((d.data() as Rec).customerId ?? ""))]);
  const ist = new Date(now + 5.5 * HOUR);
  const date = ist.toISOString().slice(0, 10);
  const dayNumber = Math.floor((now + 5.5 * HOUR) / (24 * HOUR));
  let sent = 0;
  for (const user of users.docs) {
    if (skip.has(user.id)) continue;
    const profile = user.data() as Rec;
    const prefs = (profile.preferences ?? {}) as Rec;
    if (prefs.notifications === false || prefs.mealSuggestions === false) continue;
    const lastCart = Number(((profile.cartReminder ?? {}) as Rec).lastAt ?? 0);
    if (now - lastCart < QUIET_AFTER_ORDER) continue;
    const copy = mealSuggestionFor(slot, profile, openStores, dayNumber);
    if (!copy) continue;
    try {
      await notifyMealSuggestion({uid: user.id, key: `meal:${date}:${slot}:${user.id}`, title: copy.title, body: copy.body});
      sent++;
    } catch (error) {
      logger.warn("MEAL_SUGGESTION_FAILED", {uid: user.id, slot, error: String(error)});
    }
  }
  return sent;
}
