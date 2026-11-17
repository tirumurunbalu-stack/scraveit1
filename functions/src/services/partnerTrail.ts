/**
 * Pre-launch watching of delivery partners who agreed to it: every position update their app
 * already sends while online (riderPresence, about every 15 seconds) is copied into a day trail.
 * Only partners on the consent list are recorded; trails are deleted after 60 days.
 *
 * RTDB layout (admin SDK only; client rules deny these paths):
 *   feastly/partnerTrailConsent/{riderId} = {name, since, by, note}
 *   feastly/partnerTrail/{riderId}/{YYYY-MM-DD}/{HHMMSS} = {a: lat, o: lng, c: accuracy m, j: 1 on a Scraveit order}
 *   feastly/partnerTrailDays/{YYYY-MM-DD}/{riderId} = true   (index for the 60-day clean-up)
 *   feastly/partnerDaySummary/{riderId}/{YYYY-MM-DD} = one line of totals, no locations; kept with no
 *     time limit (founder, 17 Nov 2026), removed only by "Delete history".
 */
import {db, firestoreDb} from "../admin";
import {ROOT} from "../config";
import {DomainError} from "../errors";
import {daySummary, summarizeDay, type DayActivity, type StorePlace, type TrailPoint} from "../domain/partnerActivity";

const KEEP_DAYS = 60;
const FRESH_MS = 2 * 60 * 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;

export function istParts(now: number): {date: string; hhmm: string; hhmmss: string; minute: number} {
  const d = new Date(now + IST_MS), iso = d.toISOString();
  return {date: iso.slice(0, 10), hhmm: iso.slice(11, 13) + iso.slice(14, 16), hhmmss: iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19), minute: d.getUTCHours() * 60 + d.getUTCMinutes()};
}

interface Presence {online?: boolean; updatedAt?: number; lat?: number; lng?: number; accuracy?: number; activeOrderId?: string; riderName?: string}

// The consent list is read at most once a minute per server instance (it changes rarely).
let consentCache: {at: number; ids: Set<string>} | null = null;
async function watchedIds(now: number): Promise<Set<string>> {
  if (consentCache && now - consentCache.at < 60_000) return consentCache.ids;
  const consent = ((await db.ref(`${ROOT}/partnerTrailConsent`).get()).val() ?? {}) as Record<string, unknown>;
  consentCache = {at: now, ids: new Set(Object.keys(consent))};
  return consentCache.ids;
}

/** Called for every riderPresence write: saves the position if this partner is watched and online. */
export async function recordPresencePoint(riderId: string, presence: Presence | null, now = Date.now()): Promise<boolean> {
  if (!presence || presence.online !== true || !/^[A-Za-z0-9_-]{1,128}$/.test(riderId)) return false;
  const lat = Number(presence.lat), lng = Number(presence.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return false;
  if (!(await watchedIds(now)).has(riderId)) return false;
  const {date, hhmmss} = istParts(now);
  const point: Record<string, number> = {a: Math.round(lat * 1e5) / 1e5, o: Math.round(lng * 1e5) / 1e5};
  if (Number.isFinite(Number(presence.accuracy))) point.c = Math.round(Number(presence.accuracy));
  if (presence.activeOrderId) point.j = 1;
  await db.ref(ROOT).update({[`partnerTrail/${riderId}/${date}/${hhmmss}`]: point, [`partnerTrailDays/${date}/${riderId}`]: true});
  return true;
}

/** Daily: saves a summary for every finished day that has none yet, then deletes trails older than 60 days. */
export async function cleanPartnerTrails(now = Date.now()): Promise<{summarized: number; cleaned: number}> {
  const summarized = await saveDaySummaries(now);
  return {summarized, cleaned: await cleanOldTrails(now)};
}

async function saveDaySummaries(now: number): Promise<number> {
  const today = istParts(now).date;
  const index = ((await db.ref(`${ROOT}/partnerTrailDays`).orderByKey().endBefore(today).get()).val() ?? {}) as Record<string, Record<string, boolean>>;
  const todo: Array<[string, string]> = [];
  for (const [day, riders] of Object.entries(index)) for (const id of Object.keys(riders ?? {})) todo.push([id, day]);
  if (!todo.length) return 0;
  const exists = await Promise.all(todo.map(([id, day]) => db.ref(`${ROOT}/partnerDaySummary/${id}/${day}/savedAt`).get()));
  const missing = todo.filter((_, i) => !exists[i]?.exists());
  if (!missing.length) return 0;
  const stores = await storePlaces();
  const updates: Record<string, unknown> = {};
  for (const [id, day] of missing) {
    const {activity} = await readDay(id, day, stores);
    if (activity.onlineMinutes > 0) updates[`partnerDaySummary/${id}/${day}`] = {...daySummary(activity), savedAt: now};
  }
  if (Object.keys(updates).length) await db.ref(ROOT).update(updates);
  return Object.keys(updates).length;
}

async function cleanOldTrails(now: number): Promise<number> {
  const cutoff = istParts(now - KEEP_DAYS * 24 * 60 * 60 * 1000).date;
  const old = ((await db.ref(`${ROOT}/partnerTrailDays`).orderByKey().endAt(cutoff).get()).val() ?? {}) as Record<string, Record<string, boolean>>;
  const removal: Record<string, null> = {};
  for (const [day, riders] of Object.entries(old)) {
    for (const id of Object.keys(riders ?? {})) removal[`partnerTrail/${id}/${day}`] = null;
    removal[`partnerTrailDays/${day}`] = null;
  }
  if (Object.keys(removal).length) await db.ref(ROOT).update(removal);
  return Object.keys(old).length;
}

// ----- admin page -----

async function storePlaces(): Promise<StorePlace[]> {
  const snap = await firestoreDb.collection("restaurants").limit(1000).get();
  const out: StorePlace[] = [];
  for (const doc of snap.docs) {
    const r = doc.data() as Record<string, unknown>, lat = Number(r.lat), lng = Number(r.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) out.push({name: String(r.name ?? doc.id).slice(0, 80), lat, lng});
  }
  return out;
}

/** Approved delivery partners to choose from, who is being watched, and today's recorded minutes. */
export async function listPartners(now = Date.now()) {
  const today = istParts(now).date;
  const [riders, consentSnap, todaySnap] = await Promise.all([
    firestoreDb.collection("riders").where("status", "==", "approved").limit(500).get(),
    db.ref(`${ROOT}/partnerTrailConsent`).get(),
    db.ref(`${ROOT}/partnerTrailDays/${today}`).get(),
  ]);
  const consent = (consentSnap.val() ?? {}) as Record<string, {name?: string; since?: number; note?: string}>;
  const recordingToday = (todaySnap.val() ?? {}) as Record<string, boolean>;
  const watchedIds = Object.keys(consent);
  const presence = await Promise.all(watchedIds.map((id) => db.ref(`${ROOT}/riderPresence/${id}`).get()));
  const live: Record<string, {online: boolean; updatedAt: number}> = {};
  presence.forEach((s, i) => {
    const p = (s.val() ?? {}) as Presence;
    live[watchedIds[i] ?? ""] = {online: p.online === true && now - Number(p.updatedAt) <= FRESH_MS, updatedAt: Number(p.updatedAt) || 0};
  });
  const partners = riders.docs.map((doc) => {
    const r = doc.data() as Record<string, unknown>;
    return {
      riderId: doc.id, name: String(r.fullName ?? r.name ?? "Delivery partner").slice(0, 80), phone: String(r.phone ?? "").slice(-4),
      city: String(r.city ?? "").slice(0, 40), watched: !!consent[doc.id], since: consent[doc.id]?.since ?? null, note: consent[doc.id]?.note ?? "",
      recordingToday: !!recordingToday[doc.id], onlineNow: live[doc.id]?.online ?? false,
    };
  }).sort((a, b) => Number(b.watched) - Number(a.watched) || a.name.localeCompare(b.name));
  return {today, partners};
}

export async function setWatch(riderId: string, on: boolean, by: string, note: string, now = Date.now()) {
  const rider = await firestoreDb.collection("riders").doc(riderId).get();
  if (!rider.exists) throw new DomainError("not-found", "No delivery partner with that ID.");
  const ref = db.ref(`${ROOT}/partnerTrailConsent/${riderId}`);
  if (!on) { await ref.remove(); return {watched: false}; }
  const r = rider.data() as Record<string, unknown>;
  await ref.set({name: String(r.fullName ?? r.name ?? "").slice(0, 80), since: now, by, note: note.slice(0, 200)});
  return {watched: true};
}

/** Deletes everything recorded for one partner (they asked, or they stopped). */
export async function forgetPartner(riderId: string) {
  const days = Object.keys(((await db.ref(`${ROOT}/partnerTrail/${riderId}`).get()).val() ?? {}) as Record<string, unknown>);
  const removal: Record<string, null> = {[`partnerTrail/${riderId}`]: null, [`partnerDaySummary/${riderId}`]: null};
  for (const d of days) removal[`partnerTrailDays/${d}/${riderId}`] = null;
  await db.ref(ROOT).update(removal);
  return {deletedDays: days.length};
}

async function readDay(riderId: string, date: string, stores?: StorePlace[]): Promise<{points: TrailPoint[]; activity: DayActivity}> {
  const raw = ((await db.ref(`${ROOT}/partnerTrail/${riderId}/${date}`).get()).val() ?? {}) as Record<string, {a?: number; o?: number; j?: number}>;
  // Keys are HHMMSS (every update) or HHMM (the first day's one-a-minute recorder).
  const points: TrailPoint[] = Object.entries(raw).map(([key, p]) => ({
    sec: Number(key.slice(0, 2)) * 3600 + Number(key.slice(2, 4)) * 60 + (key.length >= 6 ? Number(key.slice(4, 6)) : 0), lat: Number(p.a), lng: Number(p.o), job: p.j === 1,
  })).filter((p) => Number.isFinite(p.sec));
  const activity = summarizeDay(points, points.length ? stores ?? await storePlaces() : []);
  return {points, activity};
}

export async function partnerDay(riderId: string, date: string) {
  const {points, activity} = await readDay(riderId, date);
  const saved = (await db.ref(`${ROOT}/partnerDaySummary/${riderId}/${date}`).get()).val() as Record<string, unknown> | null;
  if (!points.length && saved) return {date, summaryOnly: true, summary: saved, trips: [], stops: [], path: [], offlineGaps: []};
  // Drops are customers' doors (often other apps' customers): their positions are not sent to the page.
  const drops = activity.stops.filter((s) => s.kind === "drop");
  const stops = activity.stops.map((s) => s.kind === "drop" ? {...s, lat: null, lng: null} : s);
  const sorted = points.slice().sort((a, b) => a.sec - b.sec), every = Math.max(1, Math.ceil(sorted.length / 1500));
  const path = sorted.filter((p, i) => (i % every === 0 || i === sorted.length - 1) && !drops.some((d) => p.sec / 60 >= d.start - 2 && p.sec / 60 <= d.end + 2))
    .map((p) => [Math.floor(p.sec / 60), p.lat, p.lng]);
  return {date, ...activity, stops, path};
}

/** Saved daily summaries for one partner (newest first, up to a year), plus today's live totals. */
export async function partnerHistory(riderId: string, now = Date.now()) {
  const saved = ((await db.ref(`${ROOT}/partnerDaySummary/${riderId}`).orderByKey().limitToLast(366).get()).val() ?? {}) as Record<string, Record<string, unknown>>;
  const today = istParts(now).date;
  const {activity} = await readDay(riderId, today);
  const days = Object.entries(saved).map(([date, v]) => ({date, ...v}));
  if (activity.onlineMinutes > 0) days.push({date: today, ...daySummary(activity), live: true} as never);
  return {days: days.sort((a, b) => String(b.date).localeCompare(String(a.date)))};
}
