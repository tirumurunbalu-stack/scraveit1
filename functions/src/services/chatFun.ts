import {randomBytes} from "node:crypto";
import {FieldValue} from "firebase-admin/firestore";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {DomainError} from "../errors";
import type {SavrivoOrder} from "../types";
import {notifyUserChat} from "./notifications";
import {requireChatter} from "./social";

/**
 * The food side of Scraveit chat: things only a food app can do.
 *
 *  - Food streaks: both friends message on the same day (India time) and the
 *    streak grows; its dish levels up. One missed day a week is forgiven. We
 *    never send "your streak is about to end" pushes - only celebrations.
 *  - Craving match: say what you're craving; a friend craving the same thing
 *    within 30 minutes makes a match, and both of you are told.
 *  - Eating now: when your food is delivered, friends see a ring on your photo
 *    for 30 minutes with the dish and restaurant (never your address). On by
 *    default from 18; off for under-18s unless they turn it on.
 *
 * Everything lives on the friendship document both friends already read.
 */

type Rec = Record<string, unknown>;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const CRAVE_WINDOW_MS = 30 * 60 * 1000;
export const EATING_WINDOW_MS = 30 * 60 * 1000;

const profiles = () => firestoreDb.collection("chatProfiles");
const friendships = () => firestoreDb.collection("friendships");

// ---------------------------------------------------------------- streaks

/** The calendar day in India, as YYYY-MM-DD. */
export function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

/** Weeks start on Monday; one forgiven day per week. */
function weekOf(day: string): number {
  return Math.floor((dayNumber(day) + 3) / 7);
}

export interface Streak {
  count: number;
  lastDay: string;
  by: Record<string, string>;
  freezeWeek?: number;
}

export const STREAK_LEVELS: Array<[number, string, string]> = [
  [100, "👑", "Royal thali"],
  [30, "🎂", "Feast"],
  [14, "🍛", "Biryani"],
  [7, "🍕", "Pizza"],
  [3, "🥟", "Momo"],
  [1, "🍞", "Toast"],
];
const MILESTONES = new Set([3, 7, 14, 30, 50, 100, 200, 365]);

export function streakLevel(count: number): {emoji: string; name: string} {
  const level = STREAK_LEVELS.find(([min]) => count >= min) ?? STREAK_LEVELS[STREAK_LEVELS.length - 1]!;
  return {emoji: level[1], name: level[2]};
}

/** The streak after `uid` sends a message on `day`. Grows once a day, when both friends have messaged. */
export function nextStreak(previous: Streak | null | undefined, uid: string, members: string[], day: string): Streak {
  const streak: Streak = {count: Number(previous?.count ?? 0), lastDay: String(previous?.lastDay ?? ""), by: {...(previous?.by ?? {})},
    ...(previous?.freezeWeek !== undefined ? {freezeWeek: previous.freezeWeek} : {})};
  streak.by[uid] = day;
  const bothToday = members.every((member) => streak.by[member] === day);
  if (!bothToday || streak.lastDay === day) return streak;
  const gap = streak.lastDay ? dayNumber(day) - dayNumber(streak.lastDay) : Infinity;
  if (gap === 1) {
    streak.count += 1;
  } else if (gap === 2 && streak.freezeWeek !== weekOf(day)) {
    streak.count += 1;
    streak.freezeWeek = weekOf(day);
  } else {
    streak.count = 1;
  }
  streak.lastDay = day;
  return streak;
}

/** A milestone worth celebrating, if this message reached one. */
export function streakMilestone(before: Streak | null | undefined, after: Streak): number {
  return after.count !== Number(before?.count ?? 0) && MILESTONES.has(after.count) ? after.count : 0;
}

/** Called from the message trigger; the friendship document is updated with the rest of the chat-list fields. */
export function streakUpdate(pair: Rec, from: string, now: number): {streak: Streak; milestone: number} {
  const before = pair.streak as Streak | undefined;
  const streak = nextStreak(before, from, (pair.members as string[]) ?? [], istDay(now));
  return {streak, milestone: streakMilestone(before, streak)};
}

export async function celebrateStreak(pair: Rec, count: number): Promise<void> {
  const members = (pair.members as string[]) ?? [];
  const names = (pair.names ?? {}) as Record<string, string>;
  const level = streakLevel(count);
  await Promise.all(members.map((uid) => {
    const other = members.find((m) => m !== uid) ?? "";
    return notifyUserChat({uid, key: `streak:${pair.id ?? members.join("_")}:${count}`,
      title: `${level.emoji} ${count}-day streak!`,
      body: `You and ${names[other] || "your friend"} hit ${count} days. Your streak is now ${level.name}.`,
      data: {route: "chats"}}).catch(() => undefined);
  }));
}

// ---------------------------------------------------------------- cravings

export const CRAVINGS: Record<string, {emoji: string; label: string}> = {
  biryani: {emoji: "🍛", label: "Biryani"},
  pizza: {emoji: "🍕", label: "Pizza"},
  burger: {emoji: "🍔", label: "Burger"},
  waffles: {emoji: "🧇", label: "Waffles"},
  icecream: {emoji: "🍦", label: "Ice cream"},
  dosa: {emoji: "🫓", label: "Dosa"},
  chicken: {emoji: "🍗", label: "Chicken 65"},
  shawarma: {emoji: "🌯", label: "Shawarma"},
  noodles: {emoji: "🍜", label: "Noodles"},
  momos: {emoji: "🥟", label: "Momos"},
  cake: {emoji: "🍰", label: "Cake"},
  shake: {emoji: "🥤", label: "Shakes"},
  chai: {emoji: "☕", label: "Chai"},
  sweets: {emoji: "🍬", label: "Sweets"},
};

/** Is the friend's craving a match for mine? Same dish, both within the last 30 minutes. */
export function isCraveMatch(mine: {dish: string; at: number}, theirs: Rec | undefined, now: number): boolean {
  return !!theirs && theirs.dish === mine.dish && now - Number(theirs.at ?? 0) <= CRAVE_WINDOW_MS && now - mine.at <= CRAVE_WINDOW_MS;
}

export async function chatCrave(uid: string, input: {dish: string}, now = Date.now()) {
  const me = await requireChatter(uid, now);
  const dish = input.dish;
  if (dish && !CRAVINGS[dish]) throw new DomainError("invalid-argument", "Pick something from the list.");
  const pairs = await friendships().where("members", "array-contains", uid).limit(300).get();
  const accepted = pairs.docs.filter((doc) => (doc.data() as Rec).status === "accepted");
  const mine = {dish, at: now};
  const matches: string[] = [];
  const batch = firestoreDb.batch();
  for (const doc of accepted) {
    const pair = doc.data() as Rec;
    const other = ((pair.members as string[]) ?? []).find((m) => m !== uid) ?? "";
    const theirs = ((pair.crave ?? {}) as Record<string, Rec>)[other];
    const update: Rec = {[`crave.${uid}`]: dish ? mine : null};
    if (dish && isCraveMatch(mine, theirs, now)) {
      update.match = {dish, at: now, members: [uid, other]};
      matches.push(doc.id);
    }
    batch.update(doc.ref, update);
  }
  batch.set(profiles().doc(uid), {craving: dish ? mine : null, updatedAt: now}, {merge: true});
  await batch.commit();
  if (matches.length) {
    const info = CRAVINGS[dish]!;
    const myName = String(me.name ?? "Your friend").split(" ")[0];
    await Promise.all(accepted.filter((doc) => matches.includes(doc.id)).map(async (doc) => {
      const pair = doc.data() as Rec;
      const other = ((pair.members as string[]) ?? []).find((m) => m !== uid) ?? "";
      const names = (pair.names ?? {}) as Record<string, string>;
      await notifyUserChat({uid: other, key: `crave-match:${doc.id}:${now}`, title: `${info.emoji} Craving match!`,
        body: `You and ${myName} both want ${info.label.toLowerCase()} right now.`, data: {route: `dm:${doc.id}`}}).catch(() => undefined);
      await notifyUserChat({uid, key: `crave-match:${doc.id}:${now}:me`, title: `${info.emoji} Craving match!`,
        body: `You and ${String(names[other] || "your friend").split(" ")[0]} both want ${info.label.toLowerCase()} right now.`, data: {route: `dm:${doc.id}`}}).catch(() => undefined);
    }));
  }
  return {dish, matches};
}

// ---------------------------------------------------------------- eating now

/** Does this person share "eating now" with friends? Adults yes unless off; under-18s only if they turned it on. */
export function sharesEating(profile: Rec | null): boolean {
  if (!profile || profile.status !== "active") return false;
  if (typeof profile.shareEating === "boolean") return profile.shareEating;
  return profile.minor !== true;
}

export function eatingCard(order: Pick<SavrivoOrder, "items" | "restaurant" | "restaurantId" | "updatedAt">, now: number): Rec {
  const first = order.items?.[0];
  return {
    dish: String(first?.name ?? "Food").slice(0, 60),
    itemId: String(first?.itemId ?? ""),
    more: Math.max(0, (order.items?.length ?? 0) - 1),
    restaurantId: String(order.restaurantId ?? ""),
    restaurantName: String(order.restaurant ?? "").slice(0, 80),
    at: now,
    until: now + EATING_WINDOW_MS,
  };
}

/** Food delivered: show it on the customer's photo for their friends. */
export async function markEatingNow(order: SavrivoOrder, now = Date.now()): Promise<void> {
  const uid = order.customerId;
  const profileSnap = await profiles().doc(uid).get();
  const profile = profileSnap.exists ? profileSnap.data() as Rec : null;
  if (!sharesEating(profile)) return;
  const card = eatingCard(order, now);
  const pairs = await friendships().where("members", "array-contains", uid).limit(300).get();
  const accepted = pairs.docs.filter((doc) => (doc.data() as Rec).status === "accepted");
  if (!accepted.length) return;
  const batch = firestoreDb.batch();
  for (const doc of accepted) batch.update(doc.ref, {[`eating.${uid}`]: card});
  await batch.commit();
  logger.info("EATING_NOW_SHARED", {uid, friends: accepted.length});
}

export async function chatSetEatingShare(uid: string, input: {share: boolean}, now = Date.now()) {
  await requireChatter(uid, now);
  await profiles().doc(uid).set({shareEating: input.share, updatedAt: now}, {merge: true});
  if (!input.share) {
    const pairs = await friendships().where("members", "array-contains", uid).limit(300).get();
    const batch = firestoreDb.batch();
    for (const doc of pairs.docs) batch.update(doc.ref, {[`eating.${uid}`]: null});
    if (pairs.docs.length) await batch.commit();
  }
  return {share: input.share};
}

// ---------------------------------------------------------------- taste match

/** Food families we can spot in dish names, with the title two friends get when they share one. */
const FAMILIES: Array<[string, RegExp, string, string]> = [
  ["biryani", /biryani|pulao/i, "Biryani twins", "🍛"],
  ["pizza", /pizza/i, "Pizza partners", "🍕"],
  ["burger", /burger/i, "Burger buddies", "🍔"],
  ["waffle", /waffle|pancake/i, "Waffle wonders", "🧇"],
  ["icecream", /ice ?cream|sundae|kulfi|gelato|scoop/i, "Ice cream crew", "🍦"],
  ["dessert", /brownie|cake|gulab|jamun|pastry|halwa|kheer|sweet|rasmalai/i, "Sweet tooth squad", "🍰"],
  ["tiffin", /dosa|idli|vada|upma|pongal|poori|puri|uttapam|pesarattu/i, "Tiffin twins", "🫓"],
  ["chicken", /chicken|tandoori|kebab|kabab|wings|65/i, "Chicken gang", "🍗"],
  ["chinese", /noodle|fried rice|manchurian|momo|chilli|schezwan/i, "Noodle nation", "🍜"],
  ["roll", /shawarma|roll|wrap|frankie/i, "Roll call", "🌯"],
  ["meals", /meals|thali|curd rice|sambar rice/i, "Meals mates", "🍱"],
  ["paneer", /paneer/i, "Paneer pals", "🧀"],
  ["bread", /naan|roti|paratha|kulcha/i, "Naan stop", "🫓"],
  ["drinks", /shake|juice|lassi|coffee|chai|tea|mojito|smoothie/i, "Sip squad", "🥤"],
];

interface OrderLike { restaurantId?: string; items?: Array<{name?: string; quantity?: number}>; status?: string }

export function tasteVector(orders: OrderLike[]): Map<string, number> {
  const v = new Map<string, number>();
  const add = (key: string, weight: number) => v.set(key, (v.get(key) ?? 0) + weight);
  for (const order of orders) {
    if (order.restaurantId) add(`r:${order.restaurantId}`, 0.6);
    for (const item of order.items ?? []) {
      const name = String(item.name ?? "").trim();
      if (!name) continue;
      const qty = Math.min(5, Math.max(1, Number(item.quantity ?? 1)));
      add(`d:${name.toLowerCase()}`, 0.8 * qty);
      for (const [family, pattern] of FAMILIES) if (pattern.test(name)) add(`f:${family}`, 1 * qty);
    }
  }
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, x] of a) { na += x * x; const y = b.get(k); if (y) dot += x * y; }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Percent, a title, and dishes both friends have ordered. Never either person's full history. */
export function tasteMatch(mine: OrderLike[], theirs: OrderLike[]) {
  const a = tasteVector(mine);
  const b = tasteVector(theirs);
  const percent = Math.min(100, Math.round(100 * (0.25 + 0.75 * cosine(a, b))));
  let best: [string, RegExp, string, string] | undefined;
  let bestScore = 0;
  for (const family of FAMILIES) {
    const score = Math.min(a.get(`f:${family[0]}`) ?? 0, b.get(`f:${family[0]}`) ?? 0);
    if (score > bestScore) { bestScore = score; best = family; }
  }
  const title = best ? best[2] : percent >= 70 ? "Food soulmates" : percent >= 45 ? "Taste buddies" : "Opposites attract";
  const emoji = best ? best[3] : percent >= 70 ? "💞" : percent >= 45 ? "🤝" : "🔀";
  const shared = [...a.keys()].filter((k) => k.startsWith("d:") && b.has(k))
    .sort((x, y) => Math.min(b.get(y)!, a.get(y)!) - Math.min(b.get(x)!, a.get(x)!))
    .slice(0, 3).map((k) => k.slice(2));
  return {percent, title, emoji, shared};
}

async function deliveredOrders(uid: string): Promise<OrderLike[]> {
  const snap = await firestoreDb.collection("orders").where("customerId", "==", uid).orderBy("createdAt", "desc").limit(60).get();
  return snap.docs.map((doc) => doc.data() as OrderLike).filter((order) => order.status === "Delivered");
}

async function acceptedPair(uid: string, pairId: string): Promise<{pair: Rec; other: string}> {
  const snap = await friendships().doc(pairId).get();
  const pair = snap.exists ? snap.data() as Rec : null;
  const members = (pair?.members as string[] | undefined) ?? [];
  if (!pair || !members.includes(uid) || pair.status !== "accepted") throw new DomainError("not-found", "That chat isn't available.");
  return {pair, other: members.find((m) => m !== uid) ?? ""};
}

export async function chatTasteMatch(uid: string, input: {pairId: string}, now = Date.now()) {
  await requireChatter(uid, now);
  const {pair, other} = await acceptedPair(uid, input.pairId);
  const cached = pair.taste as Rec | undefined;
  if (cached && now - Number(cached.at ?? 0) < 6 * 60 * 60 * 1000) return {...cached, locked: false};
  const [mine, theirs] = await Promise.all([deliveredOrders(uid), deliveredOrders(other)]);
  if (!mine.length || !theirs.length) return {locked: true, needMe: !mine.length, needThem: !theirs.length};
  const taste = {...tasteMatch(mine, theirs), at: now};
  await friendships().doc(input.pairId).update({taste});
  return {...taste, locked: false};
}

// ---------------------------------------------------------------- IOUs ("you owe me a waffle")

export const TREATS: Record<string, {emoji: string; label: string}> = {
  waffles: {emoji: "🧇", label: "waffle"},
  biryani: {emoji: "🍛", label: "biryani"},
  icecream: {emoji: "🍦", label: "ice cream"},
  pizza: {emoji: "🍕", label: "pizza"},
  chai: {emoji: "☕", label: "chai"},
  shake: {emoji: "🥤", label: "shake"},
  burger: {emoji: "🍔", label: "burger"},
  cake: {emoji: "🍰", label: "cake"},
};
const MAX_OPEN_IOUS = 20;
const NUDGE_GAP_MS = 6 * 60 * 60 * 1000;

function article(label: string): string {
  return /^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`;
}

export function iouText(owedByName: string, owedToName: string, treat: string, note: string): string {
  const t = TREATS[treat]!;
  return `🧾 ${owedByName} owes ${owedToName} ${article(t.label)} ${t.emoji}${note ? ` for ${note}` : ""}`;
}

export async function chatIou(uid: string, input: {pairId: string; action: "create" | "settle" | "forgive" | "cancel" | "nudge"; iouId?: string; treat?: string; note?: string; owedBy?: "me" | "them"}, now = Date.now()) {
  const me = await requireChatter(uid, now);
  const {pair, other} = await acceptedPair(uid, input.pairId);
  const names = (pair.names ?? {}) as Record<string, string>;
  const first = (id: string): string => String(names[id] || (id === uid ? me.name : "") || "Someone").split(" ")[0] ?? "Someone";
  const ious = (pair.ious ?? {}) as Record<string, Rec>;
  const ref = friendships().doc(input.pairId);
  const say = (text: string, iouId: string) => firestoreDb.collection("chats").doc(input.pairId).collection("messages")
    .add({from: uid, text, iou: {id: iouId}, at: FieldValue.serverTimestamp()});

  if (input.action === "create") {
    const treat = String(input.treat ?? "");
    if (!TREATS[treat]) throw new DomainError("invalid-argument", "Pick a treat.");
    if (Object.values(ious).filter((x) => x.status === "open").length >= MAX_OPEN_IOUS) {
      throw new DomainError("failed-precondition", "That's a lot of IOUs. Settle some first.");
    }
    const owedBy = input.owedBy === "me" ? uid : other;
    const owedTo = owedBy === uid ? other : uid;
    const note = String(input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const id = randomBytes(6).toString("hex");
    await ref.update({[`ious.${id}`]: {treat, note, owedBy, owedTo, by: uid, status: "open", at: now}});
    await say(iouText(first(owedBy), first(owedTo), treat, note), id);
    return {iouId: id};
  }

  const iou = input.iouId ? ious[input.iouId] : undefined;
  if (!iou || iou.status !== "open") throw new DomainError("failed-precondition", "That IOU is already closed.");
  const t = TREATS[String(iou.treat)] ?? {emoji: "🎁", label: "treat"};
  // "You owe me!": the person owed pokes the other, at most once every 6 hours per IOU.
  if (input.action === "nudge") {
    if (iou.owedTo !== uid) throw new DomainError("permission-denied", "Only the person owed can remind.");
    if (now - Number(iou.nudgedAt ?? 0) < NUDGE_GAP_MS) throw new DomainError("failed-precondition", "You reminded them already. Give them a bit!");
    await ref.update({[`ious.${input.iouId}.nudgedAt`]: now, [`ious.${input.iouId}.nudges`]: FieldValue.increment(1)});
    await say(`👀 ${first(uid)}: you still owe me ${article(t.label)} ${t.emoji}!`, String(input.iouId));
    return {status: "open"};
  }
  if (input.action === "cancel") {
    if (iou.by !== uid) throw new DomainError("permission-denied", "Only the person who added it can take it back.");
  } else if (iou.owedTo !== uid) {
    throw new DomainError("permission-denied", `Only ${first(String(iou.owedTo))} can mark this one.`);
  }
  const status = input.action === "settle" ? "paid" : input.action === "forgive" ? "forgiven" : "cancelled";
  await ref.update({[`ious.${input.iouId}.status`]: status, [`ious.${input.iouId}.closedAt`]: now});
  const text = status === "paid" ? `🎉 ${first(String(iou.owedBy))} came through with the ${t.label} ${t.emoji}` :
    status === "forgiven" ? `🕊️ ${first(uid)} put the ${t.label} on the house` : `↩️ ${first(uid)} took back the ${t.label} IOU`;
  await say(text, String(input.iouId));
  return {status};
}

// ---------------------------------------------------------------- weekly food card

/** Sunday evening: tell everyone who ate with us this week that their card is ready. */
export async function weeklyCardPush(now = Date.now()): Promise<number> {
  const since = now - 7 * DAY_MS;
  const snap = await firestoreDb.collection("orders").where("createdAt", ">=", since).limit(5000).get();
  const uids = new Set<string>();
  for (const doc of snap.docs) {
    const order = doc.data() as Rec;
    if (order.status === "Delivered" && order.customerId) uids.add(String(order.customerId));
  }
  const week = istDay(now);
  await Promise.all([...uids].map((uid) => notifyUserChat({uid, key: `week-card:${week}`, title: "✨ Your food week is ready",
    body: "See your week in food and share it on your story.", data: {route: "week"}}).catch(() => undefined)));
  logger.info("WEEKLY_CARD_PUSH", {users: uids.size});
  return uids.size;
}
