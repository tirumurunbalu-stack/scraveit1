import {istHour, istWeekday} from "./learnedTimes";

/**
 * Orders per hour, per city, for the next 24 hours, and where riders will be short.
 *
 * Food demand repeats every week (Friday dinner looks like last Friday dinner), so the forecast is
 * a weekly profile: each hour of the week averaged over the last eight weeks, recent weeks counting
 * more, then scaled by how the last seven days compare with that profile (a growing city is busier
 * than its own history). It is scored every night on the last seven days, which it did not see,
 * against the simplest honest alternative: "same hour last week".
 *
 * Rider shortage is read from the orders themselves: each order stores how many free riders were
 * near the restaurant when it was placed. Hours that were short before and are forecast busy get a
 * suggested peak bonus, which ops approve (nothing here pays anyone).
 */

export interface DemandEvent {
  readonly at: number;
  readonly cityKey: string;
  /** Free riders near the restaurant when the order was placed; null when unknown. */
  readonly availableRiders: number | null;
}

export interface HourForecast {
  readonly at: number;
  /** "Fri 19:00" India time. */
  readonly label: string;
  readonly expected: number;
  /** Share of past orders at this hour of the week that found at most one free rider. */
  readonly shortRate: number;
}

export interface BonusSuggestion {
  readonly from: number;
  readonly to: number;
  readonly label: string;
  readonly expectedOrders: number;
  readonly shortRate: number;
  /** Suggested extra pay per delivery, rupees. */
  readonly bonusPerOrder: number;
  readonly why: string;
}

export interface CityDemandForecast {
  readonly cityKey: string;
  readonly generatedAt: number;
  readonly next24: readonly HourForecast[];
  readonly expectedNext24: number;
  readonly busiest: readonly HourForecast[];
  readonly bonuses: readonly BonusSuggestion[];
  /** Backtest on the last 7 days: mean absolute error per hour, model vs "same hour last week". */
  readonly metrics: {readonly hours: number; readonly maeModel: number; readonly maeNaive: number; readonly ordersLastWeek: number};
}

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const WEEKS = 8;
const WEEK_DECAY = 0.7;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function hourOfWeek(at: number): number {
  return istWeekday(at) * 24 + istHour(at);
}

function hourLabel(at: number): string {
  return `${DAYS[istWeekday(at)]} ${String(istHour(at)).padStart(2, "0")}:00`;
}

/** Per hour-of-week counts for each of the WEEKS weeks before `end` (index 0 = the latest). */
function weeklyCounts(events: readonly DemandEvent[], end: number): number[][] {
  const weeks = Array.from({length: WEEKS}, () => new Array<number>(168).fill(0));
  for (const event of events) {
    const age = end - event.at;
    if (age <= 0) continue;
    const week = Math.floor(age / WEEK_MS);
    if (week >= WEEKS) continue;
    const counts = weeks[week] as number[], h = hourOfWeek(event.at);
    counts[h] = (counts[h] as number) + 1;
  }
  return weeks;
}

/** The weekly profile as of `end`, scaled to the level of the last 7 days. */
function profileAt(events: readonly DemandEvent[], end: number): number[] {
  const first = events.reduce((min, e) => Math.min(min, e.at), Infinity);
  const weeks = weeklyCounts(events, end);
  const profile = new Array<number>(168).fill(0);
  let weight = 0;
  weeks.forEach((counts, k) => {
    // Weeks before the city's first order are not "no demand", they are "not live yet".
    if (end - (k + 1) * WEEK_MS + WEEK_MS < first) return;
    const w = Math.pow(WEEK_DECAY, k);
    weight += w;
    counts.forEach((count, h) => { profile[h] = (profile[h] as number) + w * count; });
  });
  if (!weight) return profile;
  for (let h = 0; h < 168; h += 1) profile[h] = (profile[h] as number) / weight;
  const lastWeek = (weeks[0] as number[]).reduce((a, b) => a + b, 0);
  const profileTotal = profile.reduce((a, b) => a + b, 0);
  if (profileTotal > 0) {
    // Level change, trusted in proportion to how many orders it rests on.
    const raw = Math.min(1.8, Math.max(0.6, lastWeek / profileTotal));
    const level = (raw * lastWeek + 1 * 20) / (lastWeek + 20);
    for (let h = 0; h < 168; h += 1) profile[h] = (profile[h] as number) * level;
  }
  return profile;
}

function shortRates(events: readonly DemandEvent[]): number[] {
  // Beta(1, 4) prior: an hour with no history is assumed mostly fine (20% short).
  const short = new Array<number>(168).fill(1), seen = new Array<number>(168).fill(5);
  for (const event of events) {
    if (event.availableRiders === null || !Number.isFinite(event.availableRiders)) continue;
    const h = hourOfWeek(event.at);
    seen[h] = (seen[h] as number) + 1;
    if (event.availableRiders <= 1) short[h] = (short[h] as number) + 1;
  }
  return short.map((s, h) => s / (seen[h] as number));
}

export function suggestedBonus(expected: number, shortRate: number): number {
  if (expected < 2 || shortRate < 0.35) return 0;
  const raw = 10 + 30 * (shortRate - 0.35) / 0.65;
  return Math.min(40, Math.max(10, Math.round(raw / 5) * 5));
}

export function forecastCity(cityKey: string, cityEvents: readonly DemandEvent[], now: number): CityDemandForecast {
  const events = cityEvents.filter((e) => e.at <= now);
  const profile = profileAt(events, now);
  const shortRate = shortRates(events.filter((e) => e.at > now - WEEKS * WEEK_MS));
  const start = Math.ceil(now / HOUR_MS) * HOUR_MS;
  const next24: HourForecast[] = Array.from({length: 24}, (_, i) => {
    const at = start + i * HOUR_MS, h = hourOfWeek(at);
    return {at, label: hourLabel(at), expected: round1(profile[h] as number), shortRate: round2(shortRate[h] as number)};
  });

  // Consecutive hours with the same suggested bonus become one suggestion.
  const bonuses: BonusSuggestion[] = [];
  for (const hour of next24) {
    const bonus = suggestedBonus(hour.expected, hour.shortRate);
    if (!bonus) continue;
    const last = bonuses[bonuses.length - 1];
    if (last && last.to === hour.at && last.bonusPerOrder === bonus) {
      bonuses[bonuses.length - 1] = {...last, to: hour.at + HOUR_MS, expectedOrders: round1(last.expectedOrders + hour.expected),
        shortRate: round2(Math.max(last.shortRate, hour.shortRate)), label: `${last.label.split("–")[0]}–${String(istHour(hour.at + HOUR_MS)).padStart(2, "0")}:00`};
    } else {
      bonuses.push({from: hour.at, to: hour.at + HOUR_MS, label: `${hour.label}–${String(istHour(hour.at + HOUR_MS)).padStart(2, "0")}:00`,
        expectedOrders: hour.expected, shortRate: hour.shortRate, bonusPerOrder: bonus, why: ""});
    }
  }
  const explained = bonuses.map((b) => ({...b,
    why: `About ${Math.round(b.expectedOrders)} orders expected; at this time riders were short for ${Math.round(b.shortRate * 100)}% of orders.`}));

  // Backtest: forecast the last 7 days from what was known 7 days ago.
  const cut = now - WEEK_MS;
  const before = events.filter((e) => e.at <= cut);
  const backProfile = profileAt(before, cut);
  const actual = (weeklyCounts(events, now)[0] as number[]);
  const naive = (weeklyCounts(events, cut)[0] as number[]);
  const hadHistory = before.length > 0;
  let errModel = 0, errNaive = 0;
  for (let h = 0; h < 168; h += 1) {
    errModel += Math.abs((backProfile[h] as number) - (actual[h] as number));
    errNaive += Math.abs((naive[h] as number) - (actual[h] as number));
  }
  const ordersLastWeek = actual.reduce((a, b) => a + b, 0);
  return {
    cityKey, generatedAt: now, next24,
    expectedNext24: round1(next24.reduce((a, h) => a + h.expected, 0)),
    busiest: next24.slice().sort((a, b) => b.expected - a.expected).filter((h) => h.expected >= 1).slice(0, 3),
    bonuses: explained,
    metrics: {hours: hadHistory ? 168 : 0, maeModel: hadHistory ? round2(errModel / 168) : 0, maeNaive: hadHistory ? round2(errNaive / 168) : 0, ordersLastWeek},
  };
}

export function forecastAll(events: readonly DemandEvent[], now: number): CityDemandForecast[] {
  const byCity: Record<string, DemandEvent[]> = {};
  for (const event of events) (byCity[event.cityKey] ??= []).push(event);
  return Object.entries(byCity).map(([city, rows]) => forecastCity(city, rows, now))
    .sort((a, b) => b.expectedNext24 - a.expectedNext24);
}

function round1(value: number): number { return Math.round(value * 10) / 10; }
function round2(value: number): number { return Math.round(value * 100) / 100; }
