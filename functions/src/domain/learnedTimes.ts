/**
 * Learned kitchen-prep and rider-travel times.
 *
 * Every delivered order is a training example (services/learning captures them): how long the
 * kitchen really took, how long the ride really took. Two small statistical models learn from
 * them every night and replace the fixed guesses (restaurant's own prep figure, 22 km/h) in the
 * delivery promise and the multi-restaurant planner.
 *
 * Built for little data first, so it is accurate from the first few dozen orders and keeps
 * improving:
 *
 *  - Prep: log-minutes = mean + calibration of the restaurant's own stated prep + a per-restaurant
 *    effect + a time-of-day effect + an item-count effect. Restaurant and time-of-day effects are
 *    shrunk towards zero until there is evidence (partial pooling), so a restaurant with three
 *    orders is not judged on three orders, and a brand-new one still gets its own stated time,
 *    corrected by how stated times compare with reality across the city.
 *  - Travel: minutes = fixed + per-km, per city, pulled towards the all-city fit until a city has
 *    enough rides, times a time-of-day factor (rush hours ride slower).
 *
 * Recent orders weigh more (three-week half-life). Every fit is scored on the most recent week it
 * did not see, against the rule it replaces; a model is switched on only when it beats that rule
 * on enough orders ("champion / challenger"), so switching it on can never make promises worse.
 *
 * Pure: no clock, no database.
 */

export type DayBand = "breakfast" | "lunch" | "afternoon" | "dinner" | "late";
export const DAY_BANDS: readonly DayBand[] = ["breakfast", "lunch", "afternoon", "dinner", "late"];

/** IST hour (0-23) to a band of the food day. */
export function dayBand(hour: number): DayBand {
  if (hour >= 6 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 15) return "lunch";
  if (hour >= 15 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "dinner";
  return "late";
}

const IST_OFFSET_MS = 330 * 60_000;
export function istHour(at: number): number {
  return new Date(at + IST_OFFSET_MS).getUTCHours();
}
/** 0 = Monday ... 6 = Sunday, India time. */
export function istWeekday(at: number): number {
  return (new Date(at + IST_OFFSET_MS).getUTCDay() + 6) % 7;
}

export interface PrepSample {
  readonly restaurantId: string;
  readonly at: number;
  readonly hour: number;
  readonly items: number;
  /** What the restaurant itself said (middle of its prep window), minutes. */
  readonly statedMinutes: number;
  /** What really happened, minutes. */
  readonly minutes: number;
}

export interface TravelSample {
  readonly cityKey: string;
  readonly at: number;
  readonly hour: number;
  /** Straight-line km from restaurant to customer. */
  readonly km: number;
  /** Pickup to handover, minutes. */
  readonly minutes: number;
}

export interface ModelMetrics {
  /** Orders in the held-out week the model was scored on. */
  readonly holdout: number;
  /** Mean absolute error in minutes: the model, and the rule it replaces. */
  readonly maeModel: number;
  readonly maeBaseline: number;
  /** Share of held-out orders the model got within 5 minutes. */
  readonly within5Model: number;
  readonly within5Baseline: number;
  /** Orders the final model was fitted on. */
  readonly trainedOn: number;
}

export interface PrepModel {
  readonly kind: "prep";
  readonly version: 1;
  readonly trainedAt: number;
  readonly mu: number;
  /** Multiplies log(stated minutes): 1 means stated times are right on average. */
  readonly gamma: number;
  /** Multiplies log(1 + items). */
  readonly beta: number;
  readonly statedMean: number;
  readonly itemsMean: number;
  readonly sigma: number;
  readonly restaurants: Readonly<Record<string, {readonly effect: number; readonly n: number; readonly sigma: number}>>;
  readonly bands: Readonly<Record<string, number>>;
  readonly metrics: ModelMetrics;
  /** True only when it beat the rule it replaces (see championGate). */
  readonly active: boolean;
}

export interface TravelModel {
  readonly kind: "travel";
  readonly version: 1;
  readonly trainedAt: number;
  readonly fixed: number;
  readonly perKm: number;
  readonly cities: Readonly<Record<string, {readonly fixed: number; readonly perKm: number; readonly n: number}>>;
  readonly bands: Readonly<Record<string, number>>;
  readonly sigma: number;
  readonly metrics: ModelMetrics;
  readonly active: boolean;
}

const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS = 21;
const RESTAURANT_PRIOR = 4;
const BAND_PRIOR = 12;
const SIGMA_PRIOR = 6;
const CITY_PRIOR = 25;
const MIN_HOLDOUT = 25;

function recencyWeight(at: number, now: number): number {
  return Math.pow(0.5, Math.max(0, now - at) / DAY_MS / HALF_LIFE_DAYS);
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Drops impossible records (clock errors, an order left open overnight). */
export function cleanPrepSamples(samples: readonly PrepSample[]): PrepSample[] {
  return samples.filter((s) => s.restaurantId && Number.isFinite(s.minutes) && s.minutes >= 1 && s.minutes <= 120 &&
    Number.isFinite(s.statedMinutes) && s.statedMinutes > 0 && Number.isFinite(s.at));
}

export function cleanTravelSamples(samples: readonly TravelSample[]): TravelSample[] {
  return samples.filter((s) => Number.isFinite(s.km) && s.km >= 0.05 && s.km <= 25 && Number.isFinite(s.minutes) &&
    s.minutes >= 1 && s.minutes <= 120 && Number.isFinite(s.at) &&
    // Faster than 70 km/h door to door, or slower than 2 km/h: not a real ride.
    s.minutes >= s.km / 70 * 60 && s.minutes <= Math.max(25, s.km / 2 * 60));
}

/** The rule prep predictions replace: the restaurant's own stated time. */
export const prepBaseline = (sample: PrepSample) => sample.statedMinutes;
/** The rule travel predictions replace: 22 km/h on roads 1.3x longer than the straight line, plus 5 minutes. */
export const travelBaseline = (sample: Pick<TravelSample, "km">) => sample.km * 1.3 / 22 * 60 + 5;

export function fitPrepModel(input: readonly PrepSample[], now: number, metrics?: ModelMetrics): PrepModel {
  const samples = cleanPrepSamples(input);
  const n = samples.length;
  const w = samples.map((s) => recencyWeight(s.at, now));
  const y = samples.map((s) => Math.log(clamp(s.minutes, 2, 120)));
  const xs = samples.map((s) => Math.log(clamp(s.statedMinutes, 3, 90)));
  const xi = samples.map((s) => Math.log1p(clamp(s.items, 1, 50)));
  const band = samples.map((s) => dayBand(s.hour));
  const totalW = w.reduce((a, b) => a + b, 0) || 1;
  const statedMean = n ? xs.reduce((a, v, i) => a + v * (w[i] as number), 0) / totalW : Math.log(20);
  const itemsMean = n ? xi.reduce((a, v, i) => a + v * (w[i] as number), 0) / totalW : Math.log1p(2);
  let mu = n ? y.reduce((a, v, i) => a + v * (w[i] as number), 0) / totalW : statedMean;
  let gamma = 1;
  let beta = 0;
  const rest: Record<string, number> = {};
  const bands: Record<string, number> = {};
  const fixedPart = (i: number) => mu + gamma * ((xs[i] as number) - statedMean) + beta * ((xi[i] as number) - itemsMean);
  for (let iteration = 0; iteration < 12 && n; iteration += 1) {
    // Covariates: weighted ridge regression of the partial residual on the two centred inputs.
    // Ridge (strength 2) pulls gamma towards 1 (stated times taken at face value) and beta towards 0.
    let s11 = 2, s22 = 2, s12 = 0, t1 = 2, t2 = 0, sw = 0, sy = 0;
    for (let i = 0; i < n; i += 1) {
      const wi = w[i] as number;
      const r = (y[i] as number) - (rest[samples[i]!.restaurantId] ?? 0) - (bands[band[i]!] ?? 0);
      const a = (xs[i] as number) - statedMean, b = (xi[i] as number) - itemsMean;
      sw += wi; sy += wi * r;
      s11 += wi * a * a; s22 += wi * b * b; s12 += wi * a * b;
      t1 += wi * a * r; t2 += wi * b * r;
    }
    // Both inputs are centred with these weights, so the mean separates from the slopes.
    mu = sy / sw;
    const det = s11 * s22 - s12 * s12;
    if (Math.abs(det) > 1e-9) {
      gamma = clamp((t1 * s22 - t2 * s12) / det, 0, 1.5);
      beta = clamp((t2 * s11 - t1 * s12) / det, -0.2, 0.4);
    }
    // Per-restaurant effects, shrunk towards zero.
    const rs: Record<string, [number, number]> = {};
    for (let i = 0; i < n; i += 1) {
      const id = samples[i]!.restaurantId, wi = w[i] as number;
      const r = (y[i] as number) - fixedPart(i) - (bands[band[i]!] ?? 0);
      const acc = rs[id] ?? (rs[id] = [0, 0]);
      acc[0] += wi * r; acc[1] += wi;
    }
    for (const [id, [sum, weight]] of Object.entries(rs)) rest[id] = clamp(sum / (weight + RESTAURANT_PRIOR), -1.2, 1.2);
    const bs: Record<string, [number, number]> = {};
    for (let i = 0; i < n; i += 1) {
      const wi = w[i] as number;
      const r = (y[i] as number) - fixedPart(i) - (rest[samples[i]!.restaurantId] ?? 0);
      const acc = bs[band[i]!] ?? (bs[band[i]!] = [0, 0]);
      acc[0] += wi * r; acc[1] += wi;
    }
    for (const [key, [sum, weight]] of Object.entries(bs)) bands[key] = clamp(sum / (weight + BAND_PRIOR), -0.5, 0.5);
  }
  // Spread of what is left, overall and per restaurant (shrunk towards overall).
  let ss = 0;
  const perRest: Record<string, [number, number, number]> = {};
  for (let i = 0; i < n; i += 1) {
    const id = samples[i]!.restaurantId, wi = w[i] as number;
    const e = (y[i] as number) - fixedPart(i) - (rest[id] ?? 0) - (bands[band[i]!] ?? 0);
    ss += wi * e * e;
    const acc = perRest[id] ?? (perRest[id] = [0, 0, 0]);
    acc[0] += wi * e * e; acc[1] += wi; acc[2] += 1;
  }
  const sigma = n ? clamp(Math.sqrt(ss / totalW), 0.08, 1) : 0.35;
  const restaurants: Record<string, {effect: number; n: number; sigma: number}> = {};
  for (const [id, [sse, weight, count]] of Object.entries(perRest)) {
    restaurants[id] = {
      effect: round4(rest[id] ?? 0),
      n: count,
      sigma: round4(clamp(Math.sqrt((sse + SIGMA_PRIOR * sigma * sigma) / (weight + SIGMA_PRIOR)), 0.08, 1)),
    };
  }
  return {
    kind: "prep", version: 1, trainedAt: now,
    mu: round4(mu), gamma: round4(gamma), beta: round4(beta),
    statedMean: round4(statedMean), itemsMean: round4(itemsMean), sigma: round4(sigma),
    restaurants, bands: roundAll(bands),
    metrics: metrics ?? {holdout: 0, maeModel: 0, maeBaseline: 0, within5Model: 0, within5Baseline: 0, trainedOn: n},
    active: false,
  };
}

export interface PrepPrediction {
  /** Most likely minutes (median). */
  readonly minutes: number;
  /** 80% of orders are ready by this. */
  readonly p80: number;
  /** 20% of orders are ready by this. */
  readonly p20: number;
  /** Orders this restaurant's own effect is based on. */
  readonly evidence: number;
}

export function predictPrep(model: PrepModel, input: {restaurantId: string; hour: number; items: number; statedMinutes: number}): PrepPrediction {
  const own = model.restaurants[input.restaurantId];
  const eta = model.mu +
    model.gamma * (Math.log(clamp(input.statedMinutes, 3, 90)) - model.statedMean) +
    model.beta * (Math.log1p(clamp(input.items, 1, 50)) - model.itemsMean) +
    (own?.effect ?? 0) + (model.bands[dayBand(input.hour)] ?? 0);
  const sigma = own?.sigma ?? model.sigma;
  return {
    minutes: round1(clamp(Math.exp(eta), 2, 120)),
    p80: round1(clamp(Math.exp(eta + 0.8416 * sigma), 2, 150)),
    p20: round1(clamp(Math.exp(eta - 0.8416 * sigma), 1, 120)),
    evidence: own?.n ?? 0,
  };
}

/** Weighted least squares of minutes on km, with a ridge pull towards a prior line. */
function fitLine(points: Array<{km: number; minutes: number; w: number}>, prior: {fixed: number; perKm: number}, strength: number) {
  // The prior counts as `strength` pseudo-rides on the prior line, half at 1 km and half at 3 km,
  // which pins both its level and its slope until real rides outweigh them.
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const anchor of [1, 3]) {
    const half = strength / 2, minutes = prior.fixed + prior.perKm * anchor;
    sw += half; sx += half * anchor; sy += half * minutes; sxx += half * anchor * anchor; sxy += half * anchor * minutes;
  }
  for (const p of points) {
    sw += p.w; sx += p.w * p.km; sy += p.w * p.minutes; sxx += p.w * p.km * p.km; sxy += p.w * p.km * p.minutes;
  }
  const det = sw * sxx - sx * sx;
  if (det <= 1e-9) return prior;
  const perKm = (sw * sxy - sx * sy) / det;
  const fixed = (sy - perKm * sx) / sw;
  return {fixed: clamp(fixed, 1, 20), perKm: clamp(perKm, 0.8, 10)};
}

export function fitTravelModel(input: readonly TravelSample[], now: number, metrics?: ModelMetrics): TravelModel {
  const samples = cleanTravelSamples(input);
  const weighted = samples.map((s) => ({...s, w: recencyWeight(s.at, now)}));
  // Start from the rule in use today, so a city with no rides gets exactly today's numbers.
  const rule = {fixed: 5, perKm: 1.3 / 22 * 60};
  let bands: Record<string, number> = {};
  let global = rule;
  let cities: Record<string, {fixed: number; perKm: number; n: number}> = {};
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const unbanded = (s: typeof weighted[number]) => ({km: s.km, minutes: s.minutes / (bands[dayBand(s.hour)] ?? 1), w: s.w});
    global = fitLine(weighted.map(unbanded), rule, 10);
    const byCity: Record<string, typeof weighted> = {};
    for (const s of weighted) (byCity[s.cityKey] ??= []).push(s);
    cities = {};
    for (const [city, rows] of Object.entries(byCity)) {
      const line = fitLine(rows.map(unbanded), global, CITY_PRIOR);
      cities[city] = {fixed: round4(line.fixed), perKm: round4(line.perKm), n: rows.length};
    }
    // Time-of-day factor: actual / predicted-without-band, shrunk towards 1.
    const acc: Record<string, [number, number]> = {};
    for (const s of weighted) {
      const line = cities[s.cityKey] ?? global;
      const base = line.fixed + line.perKm * s.km;
      const key = dayBand(s.hour);
      const a = acc[key] ?? (acc[key] = [0, 0]);
      a[0] += s.w * (s.minutes / base); a[1] += s.w;
    }
    bands = {};
    for (const [key, [sum, weight]] of Object.entries(acc)) bands[key] = clamp((sum + BAND_PRIOR) / (weight + BAND_PRIOR), 0.7, 1.5);
  }
  let ss = 0, sw = 0;
  for (const s of weighted) {
    const predicted = travelMinutesWith(global, cities, bands, s.cityKey, s.hour, s.km);
    ss += s.w * (s.minutes - predicted) ** 2; sw += s.w;
  }
  return {
    kind: "travel", version: 1, trainedAt: now,
    fixed: round4(global.fixed), perKm: round4(global.perKm), cities, bands: roundAll(bands),
    sigma: round4(sw ? Math.sqrt(ss / sw) : 6),
    metrics: metrics ?? {holdout: 0, maeModel: 0, maeBaseline: 0, within5Model: 0, within5Baseline: 0, trainedOn: samples.length},
    active: false,
  };
}

function travelMinutesWith(global: {fixed: number; perKm: number}, cities: TravelModel["cities"], bands: Record<string, number>,
  cityKey: string, hour: number, km: number): number {
  const line = cities[cityKey] ?? global;
  return (line.fixed + line.perKm * Math.max(0, km)) * (bands[dayBand(hour)] ?? 1);
}

/** Minutes from pickup to the door for a straight-line distance. */
export function predictTravel(model: TravelModel, input: {cityKey: string; hour: number; km: number}): number {
  return round1(clamp(travelMinutesWith(model, model.cities, model.bands as Record<string, number>, input.cityKey, input.hour, input.km), 1, 150));
}

/** Riding minutes per straight-line km (no fixed part): for planners that add stops themselves. */
export function minutesPerStraightKm(model: TravelModel, cityKey: string, hour: number): number {
  const line = model.cities[cityKey] ?? model;
  return round4(clamp(line.perKm * (model.bands[dayBand(hour)] ?? 1), 0.8, 10));
}

function score(errors: Array<[number, number]>): {mae: number; within5: number} {
  if (!errors.length) return {mae: 0, within5: 0};
  const mae = errors.reduce((a, [p, t]) => a + Math.abs(p - t), 0) / errors.length;
  const within5 = errors.filter(([p, t]) => Math.abs(p - t) <= 5).length / errors.length;
  return {mae: round1(mae), within5: round4(within5)};
}

/** Fit on everything before the last week, score on the last week, then refit on all of it. */
export function trainPrepModel(samples: readonly PrepSample[], now: number): PrepModel {
  const clean = cleanPrepSamples(samples);
  const cut = now - 7 * DAY_MS;
  const train = clean.filter((s) => s.at < cut), test = clean.filter((s) => s.at >= cut);
  const challenger = fitPrepModel(train, cut);
  const model = score(test.map((s) => [predictPrep(challenger, s).minutes, s.minutes]));
  const baseline = score(test.map((s) => [prepBaseline(s), s.minutes]));
  const metrics: ModelMetrics = {holdout: test.length, maeModel: model.mae, maeBaseline: baseline.mae,
    within5Model: model.within5, within5Baseline: baseline.within5, trainedOn: clean.length};
  const final = fitPrepModel(clean, now, metrics);
  return {...final, active: championGate(metrics)};
}

export function trainTravelModel(samples: readonly TravelSample[], now: number): TravelModel {
  const clean = cleanTravelSamples(samples);
  const cut = now - 7 * DAY_MS;
  const train = clean.filter((s) => s.at < cut), test = clean.filter((s) => s.at >= cut);
  const challenger = fitTravelModel(train, cut);
  const model = score(test.map((s) => [predictTravel(challenger, s), s.minutes]));
  const baseline = score(test.map((s) => [travelBaseline(s), s.minutes]));
  const metrics: ModelMetrics = {holdout: test.length, maeModel: model.mae, maeBaseline: baseline.mae,
    within5Model: model.within5, within5Baseline: baseline.within5, trainedOn: clean.length};
  const final = fitTravelModel(clean, now, metrics);
  return {...final, active: championGate(metrics)};
}

/** A model replaces the rule only after beating it, by a margin, on enough unseen orders. */
export function championGate(metrics: ModelMetrics): boolean {
  return metrics.holdout >= MIN_HOLDOUT && metrics.maeModel < metrics.maeBaseline * 0.97;
}

function round1(value: number): number { return Math.round(value * 10) / 10; }
function round4(value: number): number { return Math.round(value * 10_000) / 10_000; }
function roundAll(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round4(v)]));
}
