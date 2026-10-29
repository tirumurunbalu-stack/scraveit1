import {describe, expect, it, vi} from "vitest";

// Finding riders for an order by hexagon (domain/riderHexagons.ts, services/dispatch.ts): a busy
// city reads a ring or two of hexagons, not every rider; the nearest riders are exactly the ones a
// full scan would find; a quiet area falls back to the city-wide read.

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore(), db: {}, messaging: {}, storage: {}, auth: {}};
});

import {cellToParent, getResolution, gridDistance, isValidCell} from "h3-js";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
import {haversineKm} from "../src/domain/order";
import {
  HEXAGONS_PER_QUERY,
  RIDER_HEX_RESOLUTION,
  RIDER_HEX_RINGS,
  coveredRadiusKm,
  hexagonsWithin,
  inQueryBatches,
  riderHexagon,
} from "../src/domain/riderHexagons";
import type {Presence} from "../src/types";
const {firestoreDb} = await import("../src/admin");
const {ridersInHexagons, updateRiderAvailabilityIndex} = await import("../src/services/dispatch");

const NAIDUPETA = {lat: 14.035, lng: 79.905};
const MUMBAI = {lat: 19.07, lng: 72.87};

// A fixed sequence of pseudo-random numbers, so every run places riders in the same spots.
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
function around(centre: {lat: number; lng: number}, km: number, bearing: number) {
  return {
    lat: centre.lat + (km / 111.32) * Math.cos(bearing),
    lng: centre.lng + (km / (111.32 * Math.cos(centre.lat * Math.PI / 180))) * Math.sin(bearing),
  };
}

describe("hexagons", () => {
  it("files a location in one resolution-7 hexagon, and refuses unusable locations", () => {
    const cell = riderHexagon(NAIDUPETA.lat, NAIDUPETA.lng)!;
    expect(isValidCell(cell)).toBe(true);
    expect(getResolution(cell)).toBe(RIDER_HEX_RESOLUTION);
    expect(riderHexagon(NAIDUPETA.lat + 0.001, NAIDUPETA.lng)).toBe(cell);
    for (const [lat, lng] of [[0, 0], [NaN, 79], [91, 79], [14, "x"], [null, undefined]]) expect(riderHexagon(lat, lng)).toBeNull();
  });

  it("grows ring by ring: 7 hexagons, then 19, 61, 127, 217", () => {
    const cell = riderHexagon(MUMBAI.lat, MUMBAI.lng)!;
    expect(RIDER_HEX_RINGS.map((k) => hexagonsWithin(cell, k).length)).toEqual([7, 19, 61, 127, 217]);
    for (const other of hexagonsWithin(cell, 1)) expect(gridDistance(cell, other)).toBeLessThanOrEqual(1);
    expect(inQueryBatches(hexagonsWithin(cell, 4)).map((b) => b.length)).toEqual([HEXAGONS_PER_QUERY, HEXAGONS_PER_QUERY, 1]);
  });

  it("never claims more than it read: anyone within the covered distance is in the rings read", () => {
    const next = random(7);
    for (const centre of [NAIDUPETA, MUMBAI]) {
      const origin = riderHexagon(centre.lat, centre.lng)!;
      let previous = 0;
      for (const rings of RIDER_HEX_RINGS) {
        const covered = coveredRadiusKm(centre, origin, rings);
        expect(covered).toBeGreaterThan(previous);
        previous = covered;
        const inside = new Set(hexagonsWithin(origin, rings));
        for (let i = 0; i < 400; i++) {
          const spot = around(centre, covered * Math.sqrt(next()), next() * 2 * Math.PI);
          if (haversineKm(centre, spot) > covered) continue;
          expect(inside.has(riderHexagon(spot.lat, spot.lng)!)).toBe(true);
        }
      }
      // Ring 1 is about 2 km all round; ring 8 about 15 km.
      expect(coveredRadiusKm(centre, origin, 1)).toBeGreaterThan(1.5);
      expect(coveredRadiusKm(centre, origin, 8)).toBeGreaterThan(14);
    }
    // Same hexagon system as Uber's H3: coarser parents exist, so cells are real H3 cells.
    expect(isValidCell(cellToParent(riderHexagon(MUMBAI.lat, MUMBAI.lng)!, 5))).toBe(true);
  });
});

describe("finding riders for an order", () => {
  const now = Date.now();
  async function riders(db: InMemoryFirestore, list: Array<{id: string; lat: number; lng: number; hexCell?: boolean}>) {
    for (const r of list) {
      await db.collection("riderAvailability").doc(r.id).set({
        riderId: r.id, online: true, lat: r.lat, lng: r.lng, accuracy: 15, updatedAt: now, cityKey: "mumbai",
        ...(r.hexCell === false ? {} : {hexCell: riderHexagon(r.lat, r.lng)}),
      });
    }
  }
  const usableWithin = (centre: {lat: number; lng: number}, maxKm: number) => (_id: string, presence: Presence) => {
    const distance = haversineKm(centre, {lat: Number(presence.lat), lng: Number(presence.lng)});
    return presence.online === true && distance <= maxKm ? distance : null;
  };

  it("in a busy city reads a ring or two and finds exactly the nearest 100 a full scan would", async () => {
    const db = new InMemoryFirestore();
    const next = random(42);
    const list = [
      ...Array.from({length: 180}, (_, i) => ({id: `near${i}`, ...around(MUMBAI, 3.5 * Math.sqrt(next()), next() * 2 * Math.PI)})),
      ...Array.from({length: 400}, (_, i) => ({id: `far${i}`, ...around(MUMBAI, 8 + 20 * next(), next() * 2 * Math.PI)})),
    ];
    await riders(db, list);
    const usable = usableWithin(MUMBAI, 50);
    const search = await ridersInHexagons(MUMBAI, 50, usable, db as never);
    expect(search.complete).toBe(true);
    expect(search.rings).toBeLessThanOrEqual(2);
    expect(Object.keys(search.presences).some((id) => id.startsWith("far"))).toBe(false);
    expect(Object.keys(search.presences).length).toBeLessThan(list.length / 2);
    const where = new Map(list.map((r) => [r.id, r]));
    const nearest = (ids: string[]) => ids.map((id) => ({id, d: haversineKm(MUMBAI, where.get(id)!)}))
      .sort((a, b) => a.d - b.d).slice(0, 100).map((x) => x.id);
    expect(nearest(Object.keys(search.presences))).toEqual(nearest(list.map((r) => r.id)));
  });

  it("stops once the rings reach the dispatch radius", async () => {
    const db = new InMemoryFirestore();
    await riders(db, [{id: "a", ...around(MUMBAI, 1, 0)}, {id: "b", ...around(MUMBAI, 2.5, 2)}]);
    const search = await ridersInHexagons(MUMBAI, 3, usableWithin(MUMBAI, 3), db as never);
    expect(search).toMatchObject({complete: true, rings: 2, coveredKm: 3});
    expect(Object.keys(search.presences).sort()).toEqual(["a", "b"]);
  });

  it("in a quiet town reads every ring, finds who is there, and asks for the city-wide read too", async () => {
    const db = new InMemoryFirestore();
    await riders(db, [
      {id: "town1", ...around(NAIDUPETA, 0.8, 1)}, {id: "town2", ...around(NAIDUPETA, 6, 3)},
      {id: "highway", ...around(NAIDUPETA, 13, 5)}, {id: "notFiledYet", ...around(NAIDUPETA, 1, 1), hexCell: false},
    ]);
    const search = await ridersInHexagons(NAIDUPETA, 50, usableWithin(NAIDUPETA, 50), db as never);
    expect(search.complete).toBe(false);
    expect(search.rings).toBe(8);
    expect(search.hexagons).toBe(217);
    expect(Object.keys(search.presences).sort()).toEqual(["highway", "town1", "town2"]);
  });

  it("reads nothing for a restaurant without a usable location", async () => {
    const search = await ridersInHexagons({lat: NaN, lng: NaN}, 50, () => 0, new InMemoryFirestore() as never);
    expect(search).toMatchObject({complete: false, rings: 0, hexagons: 0, presences: {}});
  });

  it("files each rider's hexagon with their latest location, and removes them when they go offline", async () => {
    const at = {online: true, lat: MUMBAI.lat, lng: MUMBAI.lng, updatedAt: now, city: "Mumbai", riderName: "Ravi"} as Presence;
    await updateRiderAvailabilityIndex("rider1", null, at);
    const db = firestoreDb as unknown as InMemoryFirestore;
    expect((await db.collection("riderAvailability").doc("rider1").get()).data()).toMatchObject({
      hexCell: riderHexagon(MUMBAI.lat, MUMBAI.lng), cityKey: "mumbai", lat: MUMBAI.lat,
    });
    const moved = around(MUMBAI, 5, 0);
    await updateRiderAvailabilityIndex("rider1", at, {...at, ...moved});
    expect((await db.collection("riderAvailability").doc("rider1").get()).data()?.hexCell).toBe(riderHexagon(moved.lat, moved.lng));
    await updateRiderAvailabilityIndex("rider1", at, {...at, online: false});
    expect((await db.collection("riderAvailability").doc("rider1").get()).exists).toBe(false);
  });
});
