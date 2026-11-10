import {describe, expect, it} from "vitest";
import {
  championGate,
  cleanTravelSamples,
  dayBand,
  fitPrepModel,
  fitTravelModel,
  minutesPerStraightKm,
  predictPrep,
  predictTravel,
  trainPrepModel,
  trainTravelModel,
  type PrepSample,
  type TravelSample,
} from "../src/domain/learnedTimes";

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const DAY = 86_400_000;

/** Deterministic pseudo-random numbers (mulberry32), so tests never flake. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(next: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, next()))) * Math.cos(2 * Math.PI * next());
}

/**
 * Three kitchens: one says 20 and takes ~20, one says 20 and takes ~30, one says 30 and takes ~18.
 * Dinner is 15% slower everywhere. Noise is ±15% (lognormal).
 */
function prepWorld(perRestaurant: number, seed = 7): PrepSample[] {
  const next = rng(seed);
  const truth: Array<{id: string; stated: number; real: number}> = [
    {id: "honest", stated: 20, real: 20}, {id: "slow", stated: 20, real: 30}, {id: "fast", stated: 30, real: 18},
  ];
  const out: PrepSample[] = [];
  for (const r of truth) {
    for (let i = 0; i < perRestaurant; i += 1) {
      const hour = i % 2 ? 20 : 13;
      const at = NOW - Math.floor(next() * 40 * DAY);
      const minutes = r.real * (hour === 20 ? 1.15 : 1) * Math.exp(0.15 * normal(next));
      out.push({restaurantId: r.id, at, hour, items: 1 + Math.floor(next() * 4), statedMinutes: r.stated, minutes});
    }
  }
  return out;
}

describe("prep model", () => {
  it("learns each kitchen's real time, not what it says", () => {
    const model = fitPrepModel(prepWorld(60), NOW);
    const lunch = (id: string, stated: number) => predictPrep(model, {restaurantId: id, hour: 13, items: 2, statedMinutes: stated}).minutes;
    expect(lunch("honest", 20)).toBeGreaterThan(17);
    expect(lunch("honest", 20)).toBeLessThan(23);
    expect(lunch("slow", 20)).toBeGreaterThan(26);
    expect(lunch("slow", 20)).toBeLessThan(34);
    expect(lunch("fast", 30)).toBeGreaterThan(15);
    expect(lunch("fast", 30)).toBeLessThan(21);
  });

  it("learns that dinner is slower", () => {
    const model = fitPrepModel(prepWorld(60), NOW);
    const lunch = predictPrep(model, {restaurantId: "honest", hour: 13, items: 2, statedMinutes: 20}).minutes;
    const dinner = predictPrep(model, {restaurantId: "honest", hour: 20, items: 2, statedMinutes: 20}).minutes;
    expect(dinner / lunch).toBeGreaterThan(1.05);
    expect(dinner / lunch).toBeLessThan(1.25);
  });

  it("does not judge a kitchen on a handful of orders (shrinks towards the city)", () => {
    const few = prepWorld(60).filter((s) => s.restaurantId !== "slow").concat(prepWorld(2, 99).filter((s) => s.restaurantId === "slow"));
    const model = fitPrepModel(few, NOW);
    const slow = predictPrep(model, {restaurantId: "slow", hour: 13, items: 2, statedMinutes: 20});
    expect(slow.evidence).toBe(2);
    // Two slow orders move it a little above the stated 20, nowhere near the full 30.
    expect(slow.minutes).toBeGreaterThan(19);
    expect(slow.minutes).toBeLessThan(27);
  });

  it("uses a new kitchen's own stated time", () => {
    const model = fitPrepModel(prepWorld(60), NOW);
    const newcomer15 = predictPrep(model, {restaurantId: "new", hour: 13, items: 2, statedMinutes: 15}).minutes;
    const newcomer40 = predictPrep(model, {restaurantId: "new", hour: 13, items: 2, statedMinutes: 40}).minutes;
    expect(newcomer40).toBeGreaterThan(newcomer15);
  });

  it("gives a window that contains most real times", () => {
    const model = fitPrepModel(prepWorld(80), NOW);
    const test = prepWorld(40, 1234);
    const inside = test.filter((s) => {
      const p = predictPrep(model, s);
      return s.minutes >= p.p20 && s.minutes <= p.p80;
    }).length / test.length;
    expect(inside).toBeGreaterThan(0.45);
    expect(inside).toBeLessThan(0.75);
  });

  it("switches on only after beating the stated times on unseen orders", () => {
    const model = trainPrepModel(prepWorld(80), NOW);
    expect(model.metrics.holdout).toBeGreaterThanOrEqual(25);
    expect(model.metrics.maeModel).toBeLessThan(model.metrics.maeBaseline);
    expect(model.active).toBe(true);
    const tiny = trainPrepModel(prepWorld(3), NOW);
    expect(tiny.active).toBe(false);
  });

  it("stays off when stated times are already right", () => {
    const honest = prepWorld(80).map((s) => ({...s, statedMinutes: s.minutes}));
    expect(trainPrepModel(honest, NOW).active).toBe(false);
  });
});

function travelWorld(n: number, seed = 3): TravelSample[] {
  const next = rng(seed);
  const out: TravelSample[] = [];
  for (let i = 0; i < n; i += 1) {
    const city = i % 3 === 0 ? "kavali" : "nellore";
    const km = 0.5 + next() * 6;
    const hour = i % 4 === 0 ? 19 : 15;
    // Nellore: 3 min + 4 min/km; Kavali (open roads): 2 min + 2.5 min/km. Evenings 20% slower.
    const base = city === "nellore" ? 3 + 4 * km : 2 + 2.5 * km;
    const minutes = base * (hour === 19 ? 1.2 : 1) + normal(next) * 1.2;
    out.push({cityKey: city, at: NOW - Math.floor(next() * 30 * DAY), hour, km, minutes: Math.max(1.5, minutes)});
  }
  return out;
}

describe("travel model", () => {
  it("learns each city's speed and the evening slowdown", () => {
    const model = fitTravelModel(travelWorld(600), NOW);
    expect(predictTravel(model, {cityKey: "nellore", hour: 15, km: 3})).toBeGreaterThan(13);
    expect(predictTravel(model, {cityKey: "nellore", hour: 15, km: 3})).toBeLessThan(17);
    expect(predictTravel(model, {cityKey: "kavali", hour: 15, km: 3})).toBeGreaterThan(8);
    expect(predictTravel(model, {cityKey: "kavali", hour: 15, km: 3})).toBeLessThan(11);
    const evening = predictTravel(model, {cityKey: "nellore", hour: 19, km: 3});
    expect(evening / predictTravel(model, {cityKey: "nellore", hour: 15, km: 3})).toBeGreaterThan(1.1);
    expect(minutesPerStraightKm(model, "nellore", 15)).toBeGreaterThan(3.3);
  });

  it("falls back to the all-city line for a city with no rides", () => {
    const model = fitTravelModel(travelWorld(600), NOW);
    const unknown = predictTravel(model, {cityKey: "ongole", hour: 15, km: 3});
    expect(unknown).toBeGreaterThan(8);
    expect(unknown).toBeLessThan(17);
  });

  it("beats the 22 km/h rule on unseen rides and switches on", () => {
    const model = trainTravelModel(travelWorld(600), NOW);
    expect(model.metrics.maeModel).toBeLessThan(model.metrics.maeBaseline);
    expect(model.active).toBe(true);
  });

  it("drops impossible rides", () => {
    const rows: TravelSample[] = [
      {cityKey: "x", at: NOW, hour: 12, km: 5, minutes: 1},
      {cityKey: "x", at: NOW, hour: 12, km: 1, minutes: 200},
      {cityKey: "x", at: NOW, hour: 12, km: 2, minutes: 10},
    ];
    expect(cleanTravelSamples(rows)).toHaveLength(1);
  });
});

describe("bands and gate", () => {
  it("maps hours to the food day", () => {
    expect(dayBand(8)).toBe("breakfast");
    expect(dayBand(13)).toBe("lunch");
    expect(dayBand(16)).toBe("afternoon");
    expect(dayBand(21)).toBe("dinner");
    expect(dayBand(2)).toBe("late");
  });
  it("requires a real margin on enough orders", () => {
    expect(championGate({holdout: 30, maeModel: 4, maeBaseline: 6, within5Model: 0, within5Baseline: 0, trainedOn: 100})).toBe(true);
    expect(championGate({holdout: 30, maeModel: 5.95, maeBaseline: 6, within5Model: 0, within5Baseline: 0, trainedOn: 100})).toBe(false);
    expect(championGate({holdout: 10, maeModel: 2, maeBaseline: 6, within5Model: 0, within5Baseline: 0, trainedOn: 100})).toBe(false);
  });
});
