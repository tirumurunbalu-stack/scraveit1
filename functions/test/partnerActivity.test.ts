import {describe, expect, it} from "vitest";
import {daySummary, nightHome, summarizeDay, type TrailPoint} from "../src/domain/partnerActivity";

// About 111 m per 0.001 degree of latitude. Positions every 15 seconds, like the app sends.
const STEP = 15;
const at = (sec: number, lat: number, lng = 79.9): TrailPoint => ({sec, lat, lng, job: false});
const still = (fromMin: number, minutes: number, lat: number) => Array.from({length: Math.round(minutes * 60 / STEP)}, (_, i) => at(fromMin * 60 + i * STEP, lat));
const ride = (fromMin: number, minutes: number, lat0: number, dLat = 0.001) => Array.from({length: Math.round(minutes * 60 / STEP)}, (_, i) => at(fromMin * 60 + i * STEP, lat0 + dLat * (i + 1)));

describe("summarizeDay", () => {
  it("catches a quick 2-minute pickup at a repeat restaurant, then the ride and drop", () => {
    const pts = [
      ...ride(595, 5, 14.895, 0.00025),  // rides in from home
      ...still(600, 5, 14.9),            // 10:00 restaurant A, 5 min (anchor visit)
      ...ride(605, 6, 14.9),             // ride north
      ...still(611, 2, 14.924),          // drop, 2 min
      ...ride(613, 6, 14.924, -0.001),   // back south
      ...still(640, 2, 14.9),            // 10:40 restaurant A again, quick 2-min pickup
      ...ride(642, 5, 14.9),
      ...still(647, 2, 14.92),           // drop
    ];
    const d = summarizeDay(pts, []);
    expect(d.stops.map((s) => s.kind)).toEqual(["restaurant", "drop", "restaurant", "drop"]);
    expect(d.trips).toHaveLength(2);
    expect(d.trips[1]).toMatchObject({pickupAt: 640, waitMinutes: 2, dropMinutes: 2});
    expect(d.offlineGaps).toHaveLength(1);
  });
  it("a 45-second red light is not a stop", () => {
    const pts = [...ride(600, 3, 14.9), ...Array.from({length: 3}, (_, i) => at(603 * 60 + i * STEP, 14.912)), ...ride(604, 3, 14.912)];
    expect(summarizeDay(pts, []).stops).toHaveLength(0);
  });
  it("names a Scraveit store and marks a long lone stop as idle", () => {
    const pts = [...still(600, 4, 14.9), ...ride(604, 4, 14.9), ...still(608, 25, 14.95)];
    const d = summarizeDay(pts, [{name: "Waffle Spot", lat: 14.9002, lng: 79.9}]);
    expect(d.stops[0]).toMatchObject({kind: "restaurant", place: "Waffle Spot"});
    expect(d.stops[1]?.kind).toBe("idle");
    expect(d.idleMinutes).toBe(25);
    expect(d.onlineMinutes).toBe(33);
  });
  it("still reads the first day's one-a-minute points", () => {
    const pts = Array.from({length: 15}, (_, i) => at((1120 + i) * 60, 14.9));
    expect(summarizeDay(pts, []).stops[0]).toMatchObject({kind: "idle", minutes: 15, start: 1120});
  });
  it("never counts the start spot (home) as a restaurant when he comes back", () => {
    const pts = [...still(600, 15, 14.9), ...ride(615, 5, 14.9), ...still(620, 2, 14.93), ...ride(622, 5, 14.93, -0.006), ...still(660, 12, 14.9)];
    const d = summarizeDay(pts, []);
    expect(d.stops.map((x) => x.kind)).toEqual(["idle", "stop", "idle"]);
    expect(d.stops[2]?.place).toBe("Where he went online");
    expect(d.trips).toHaveLength(0);
  });
  it("handles an empty day", () => {
    const d = summarizeDay([], []);
    expect(d.onlineMinutes).toBe(0);
    expect(d.firstSeen).toBeNull();
  });
});

describe("daySummary", () => {
  it("keeps totals and averages but no positions", () => {
    const a = {
      onlineMinutes: 120, outMinutes: 120, homeMinutes: 0, home: null, movingMinutes: 60, restaurantWaitMinutes: 20, dropMinutes: 6, idleMinutes: 15, otherStopMinutes: 4,
      trips: [{pickupAt: 600, waitMinutes: 5, rideMinutes: 10, dropMinutes: 2, place: ""}, {pickupAt: 660, waitMinutes: 8, rideMinutes: 13, dropMinutes: 4, place: "X"}],
      stops: [], firstSeen: 590, lastSeen: 720, offlineGaps: [{start: 700, end: 705}],
    };
    const s = daySummary(a);
    expect(s).toMatchObject({trips: 2, avgWaitMinutes: 7, avgRideMinutes: 12, gaps: 1, onlineMinutes: 120});
    expect(JSON.stringify(s)).not.toMatch(/lat|lng/);
    expect(daySummary({...a, trips: []}).avgWaitMinutes).toBeNull();
  });
});

describe("GPS drift while waiting", () => {
  it("joins a split wait and does not call it a repeat visit", () => {
    const pts: TrailPoint[] = [];
    let t = 19 * 3600;
    const at = (lat: number, lng: number, n: number) => { for (let i = 0; i < n; i++) { pts.push({sec: t, lat, lng, job: false}); t += 15; } };
    at(14.4000, 79.9300, 8);                // start spot
    for (let i = 1; i <= 20; i++) at(14.4000 + i * 0.0009, 79.9300 + i * 0.0006, 1); // ride
    at(14.41727, 79.94171, 24);             // 6 min
    at(14.41689, 79.94176, 36);             // 9 min, ~42 m away
    at(14.41744, 79.94204, 12);             // 3 min, ~68 m away
    const d = summarizeDay(pts, []);
    const waits = d.stops.filter((s) => s.start >= 19 * 60 + 2);
    expect(waits).toHaveLength(1);
    expect(waits[0]?.kind).toBe("idle");
    expect(waits[0]?.minutes).toBeGreaterThanOrEqual(17);
    expect(d.trips).toHaveLength(0);
  });
});

describe("home learned from the night", () => {
  it("finds the night spot, counts it as home and keeps it out of idle and out-working time", () => {
    const pts: TrailPoint[] = [];
    const at = (from: number, to: number, lat: number, lng: number) => { for (let t = from; t < to; t += 15) pts.push({sec: t, lat, lng, job: false}); };
    at(0, 6 * 3600, 14.41743, 79.94175);               // night at home
    for (let i = 1; i <= 20; i++) pts.push({sec: 6 * 3600 + i * 15, lat: 14.41743 - i * 0.0006, lng: 79.94175 + i * 0.0006, job: false});
    at(6 * 3600 + 400, 6 * 3600 + 400 + 40 * 60, 14.4050, 79.9540); // 40 min out, away from home
    for (let i = 1; i <= 20; i++) pts.push({sec: 7 * 3600 + i * 15, lat: 14.4050 + i * 0.0006, lng: 79.9540 - i * 0.0006, job: false});
    at(7 * 3600 + 400, 8 * 3600, 14.41740, 79.94170);  // back home
    const home = nightHome(pts);
    expect(home).not.toBeNull();
    const d = summarizeDay(pts, []);
    expect(d.homeMinutes).toBeGreaterThan(6 * 60);
    expect(d.idleMinutes).toBeGreaterThanOrEqual(39);
    expect(d.idleMinutes).toBeLessThan(45);
    expect(d.outMinutes).toBeLessThan(60);
    expect(d.stops.filter((s) => s.kind === "home").every((s) => s.place === "Home")).toBe(true);
  });
  it("no long night stay: no home", () => {
    const pts: TrailPoint[] = [];
    for (let t = 12 * 3600; t < 14 * 3600; t += 15) pts.push({sec: t, lat: 14.4, lng: 79.9, job: false});
    expect(nightHome(pts)).toBeNull();
    expect(summarizeDay(pts, []).homeMinutes).toBe(0);
  });
});
