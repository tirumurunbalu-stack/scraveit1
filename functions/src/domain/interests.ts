/**
 * What each customer is into, what each city orders, and what ads earn.
 *
 *  - Interests: every look, open, add-to-cart and order nudges a customer's score for that
 *    restaurant and its cuisines. Scores fade with a 30-day half-life, so taste changes are
 *    followed. The customer app ranks "For you" with them, and brand ads are shown only to
 *    customers whose interests match the ad's audience.
 *  - City ranking: per restaurant, how often a card that was seen got opened and ordered from.
 *    The customer app samples from these rates (Thompson sampling, a bandit), so restaurants that
 *    convert rise, and new restaurants still get shown often enough to prove themselves.
 *  - Ads: impressions, reach, clicks and orders per store per day, and the money they made.
 */

const DAY_MS = 86_400_000;
const INTEREST_HALF_LIFE_DAYS = 30;
const RANK_DAILY_DECAY = 0.93;
const MAX_RESTAURANTS = 40;
const MAX_CUISINES = 20;

export type AppEventType = "imp" | "open" | "add" | "adImp" | "adClick" | "brandImp" | "brandClick";

export interface AppEvent {
  readonly t: AppEventType;
  /** Restaurant (all but brand events). */
  readonly rid?: string;
  /** Brand ad id (brand events). */
  readonly adId?: string;
  /** Milliseconds the card or page was on screen. */
  readonly ms?: number;
  readonly cuisines?: readonly string[];
  readonly city?: string;
  readonly at: number;
}

export interface InterestProfile {
  /** Restaurant id to score. */
  readonly r: Readonly<Record<string, number>>;
  /** Cuisine key ("biryani") to score. */
  readonly c: Readonly<Record<string, number>>;
  readonly updatedAt: number;
}

export const EMPTY_PROFILE: InterestProfile = {r: {}, c: {}, updatedAt: 0};

export function cuisineKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** How much one event says about taste. A glance says little; an order says a lot. */
export function eventWeight(event: Pick<AppEvent, "t" | "ms">): number {
  const seconds = Math.max(0, Number(event.ms) || 0) / 1000;
  switch (event.t) {
  case "imp": return seconds >= 1 ? 0.05 : 0;
  case "adImp": return seconds >= 1 ? 0.05 : 0;
  case "open": return 1 + Math.min(2, seconds / 20);
  case "add": return 3;
  case "adClick": return 1.5;
  default: return 0;
  }
}

export const ORDER_WEIGHT = 6;

function fade(scores: Readonly<Record<string, number>>, factor: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(scores)) {
    const next = (Number(value) || 0) * factor;
    if (next >= 0.01) out[key] = next;
  }
  return out;
}

function top(scores: Record<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries(Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([key, value]) => [key, Math.round(value * 1000) / 1000]));
}

/** Adds signals to a profile. `extra` carries server-side signals such as a placed order. */
export function applyInterestEvents(profile: InterestProfile | null | undefined, events: readonly AppEvent[], now: number,
  extra: ReadonlyArray<{rid: string; cuisines: readonly string[]; weight: number}> = []): InterestProfile {
  const base = profile ?? EMPTY_PROFILE;
  const factor = base.updatedAt ? Math.pow(0.5, Math.max(0, now - base.updatedAt) / DAY_MS / INTEREST_HALF_LIFE_DAYS) : 1;
  const r = fade(base.r, factor), c = fade(base.c, factor);
  const add = (rid: string | undefined, cuisines: readonly string[] | undefined, weight: number) => {
    if (weight <= 0) return;
    if (rid) r[rid] = (r[rid] ?? 0) + weight;
    for (const cuisine of (cuisines ?? []).slice(0, 3)) {
      const key = cuisineKey(cuisine);
      if (key) c[key] = (c[key] ?? 0) + weight / 2;
    }
  };
  for (const event of events) add(event.rid, event.cuisines, eventWeight(event));
  for (const signal of extra) add(signal.rid, signal.cuisines, signal.weight);
  return {r: top(r, MAX_RESTAURANTS), c: top(c, MAX_CUISINES), updatedAt: now};
}

/** Does a customer belong to a brand ad's audience? An ad with no audience is for everyone. */
export function matchesAudience(profile: InterestProfile | null | undefined, audience: readonly string[] | null | undefined, minScore = 1): boolean {
  const wanted = (audience ?? []).map(cuisineKey).filter(Boolean);
  if (!wanted.length) return true;
  const scores = profile?.c ?? {};
  return wanted.some((key) => (scores[key] ?? 0) >= minScore);
}

export interface RankCounts { readonly imp: number; readonly open: number; readonly order: number }
export interface RankModel {
  readonly restaurants: Readonly<Record<string, RankCounts>>;
  readonly updatedAt: number;
}

/** Folds yesterday's counts into the city's ranking memory; older evidence fades 7% a day. */
export function foldRankModel(model: RankModel | null | undefined, days: ReadonlyArray<{day: number; restaurants: Readonly<Record<string, Partial<RankCounts>>>}>, now: number): RankModel {
  const out: Record<string, {imp: number; open: number; order: number}> = {};
  const since = model?.updatedAt ?? now;
  const keep = Math.pow(RANK_DAILY_DECAY, Math.max(0, now - since) / DAY_MS);
  for (const [rid, counts] of Object.entries(model?.restaurants ?? {})) {
    out[rid] = {imp: counts.imp * keep, open: counts.open * keep, order: counts.order * keep};
  }
  for (const {day, restaurants} of days) {
    const weight = Math.pow(RANK_DAILY_DECAY, Math.max(0, now - day) / DAY_MS);
    for (const [rid, counts] of Object.entries(restaurants)) {
      const row = out[rid] ?? (out[rid] = {imp: 0, open: 0, order: 0});
      row.imp += weight * Math.max(0, Number(counts.imp) || 0);
      row.open += weight * Math.max(0, Number(counts.open) || 0);
      row.order += weight * Math.max(0, Number(counts.order) || 0);
    }
  }
  const rounded: Record<string, RankCounts> = {};
  for (const [rid, row] of Object.entries(out)) {
    if (row.imp + row.open + row.order < 0.05) continue;
    rounded[rid] = {imp: round2(row.imp), open: round2(row.open), order: round2(row.order)};
  }
  return {restaurants: rounded, updatedAt: now};
}

/**
 * Expected order rate per card shown, with a prior worth 20 impressions at the city's own
 * average rate. This is the posterior mean the app samples around.
 */
export function orderRate(counts: RankCounts | undefined, cityRate: number): number {
  const prior = 20;
  return ((counts?.order ?? 0) + prior * cityRate) / ((counts?.imp ?? 0) + prior);
}

export function cityOrderRate(model: RankModel): number {
  let imp = 0, order = 0;
  for (const counts of Object.values(model.restaurants)) { imp += counts.imp; order += counts.order; }
  return imp > 0 ? Math.min(0.5, Math.max(0.005, order / imp)) : 0.03;
}

export interface AdDay {
  readonly day: string;
  readonly impressions: number;
  readonly reach: number;
  readonly clicks: number;
  readonly viewMs: number;
  readonly orders: number;
  readonly sales: number;
  readonly deliveredOrders: number;
  readonly deliveredSales: number;
  readonly cancelledOrders: number;
}

export interface AdResults {
  readonly impressions: number;
  readonly reach: number;
  readonly clicks: number;
  /** Clicks per impression. */
  readonly ctr: number;
  readonly orders: number;
  /** Food value of delivered orders from ad clicks, rupees: what the ads earned. */
  readonly earned: number;
  /** Orders from ad clicks still on their way. */
  readonly pendingOrders: number;
  readonly cancelledOrders: number;
  /** What the store paid for those days, rupees, before GST. */
  readonly spent: number;
  /** Earned per rupee spent. */
  readonly roas: number;
  /** Average seconds a customer looked at the ad card. */
  readonly avgViewSeconds: number;
}

export function adDayOf(value: Record<string, unknown> | null | undefined, day: string): AdDay {
  const n = (key: string) => Math.max(0, Number(value?.[key]) || 0);
  return {day, impressions: n("impressions"), reach: n("reach"), clicks: n("clicks"), viewMs: n("viewMs"),
    orders: n("orders"), sales: n("sales"), deliveredOrders: n("deliveredOrders"), deliveredSales: n("deliveredSales"),
    cancelledOrders: n("cancelledOrders")};
}

export function summarizeAdDays(days: readonly AdDay[], spentRupees: number): AdResults {
  const sum = (key: keyof Omit<AdDay, "day">) => days.reduce((a, d) => a + (d[key] as number), 0);
  const impressions = sum("impressions"), clicks = sum("clicks"), earned = round2(sum("deliveredSales"));
  const orders = sum("orders"), delivered = sum("deliveredOrders"), cancelled = sum("cancelledOrders");
  return {
    impressions, reach: sum("reach"), clicks,
    ctr: impressions ? round4(clicks / impressions) : 0,
    orders, earned,
    pendingOrders: Math.max(0, orders - delivered - cancelled),
    cancelledOrders: cancelled,
    spent: round2(spentRupees),
    roas: spentRupees > 0 ? round2(earned / spentRupees) : 0,
    avgViewSeconds: impressions ? Math.round(sum("viewMs") / impressions / 100) / 10 : 0,
  };
}

/** An order counts as "from an ad" when the customer tapped that store's ad in the 24 hours before ordering. */
export const AD_ATTRIBUTION_WINDOW_MS = 24 * 3_600_000;
export function attributedClick(clickTimes: readonly number[], orderAt: number): number | null {
  const valid = clickTimes.filter((t) => Number.isFinite(t) && t <= orderAt && orderAt - t <= AD_ATTRIBUTION_WINDOW_MS);
  return valid.length ? Math.max(...valid) : null;
}

/** Caps per customer, per store, per day, so one phone cannot inflate a store's numbers. */
export const AD_CAPS = {impressions: 20, clicks: 5} as const;

function round2(value: number): number { return Math.round(value * 100) / 100; }
function round4(value: number): number { return Math.round(value * 10_000) / 10_000; }
