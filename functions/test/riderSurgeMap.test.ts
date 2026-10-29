import {describe, expect, it, vi} from "vitest";

// Rider surge by hexagon: a restaurant's surge comes from the riders around it, so one busy
// neighbourhood surges while the rest of the city stays at the normal price.

vi.mock("../src/admin", () => ({firestoreDb: {}, db: {}, messaging: {}, storage: {}, auth: {}}));

import type {DecodedIdToken} from "firebase-admin/auth";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
import {riderHexagon} from "../src/domain/riderHexagons";
import {riderSupply, riderSurgeFee, riderSurgeLevel} from "../src/domain/riderSurge";
const {readRiderSurgeMap, riderSurgeFeeNear} = await import("../src/services/riderSurgeMap");

const NOW = 1_800_000_000_000;
const ON = {riderSurgeEnabled: true};
const admin = {uid: "admin1", savrivoRole: "owner"} as unknown as DecodedIdToken;
const customer = {uid: "c1"} as unknown as DecodedIdToken;
// Naidupeta's centre and a spot about 12 km away in the same city.
const CENTRE = {lat: 14.035, lng: 79.905};
const FAR = {lat: 14.143, lng: 79.905};

function near(point: {lat: number; lng: number}, i: number) {
  return {lat: point.lat + (i % 5) * 0.002, lng: point.lng + Math.floor(i / 5) * 0.002};
}

async function cityWith(groups: Array<{at: {lat: number; lng: number}; count: number; busy: number; filed?: boolean; seenAgoMs?: number}>) {
  const db = new InMemoryFirestore();
  let n = 0;
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) {
      const spot = near(group.at, i);
      await db.collection("riderAvailability").doc(`r${n++}`).set({
        online: true, cityKey: "naidupeta", ...spot, updatedAt: NOW - (group.seenAgoMs ?? 10_000),
        ...(i < group.busy ? {activeOrderId: `o${n}`} : {}),
        ...(group.filed === false ? {} : {hexCell: riderHexagon(spot.lat, spot.lng)}),
      });
    }
  }
  return db;
}

describe("how busy and what it costs", () => {
  it("keeps the fee tiers it always had", () => {
    const fee = (online: number, busy: number) => riderSurgeFee(ON, {onlineRiders: online, busyRiders: busy});
    expect([fee(10, 6), fee(10, 7), fee(10, 9), fee(10, 10), fee(2, 2)]).toEqual([0, 10, 20, 30, 0]);
    expect(riderSurgeFee({}, {onlineRiders: 10, busyRiders: 10})).toBe(0);
    expect(riderSurgeFee({...ON, riderSurgeHighFee: 500}, {onlineRiders: 4, busyRiders: 4})).toBe(100);
    expect([riderSurgeLevel({}, {onlineRiders: 2, busyRiders: 0}), riderSurgeLevel({}, {onlineRiders: 10, busyRiders: 5}),
      riderSurgeLevel({}, {onlineRiders: 10, busyRiders: 10})]).toEqual([-1, 0, 3]);
  });

  it("counts only riders seen in the last 90 seconds", () => {
    expect(riderSupply([
      {online: true, updatedAt: NOW - 5_000, activeOrderId: "o1"}, {online: true, updatedAt: NOW - 5_000},
      {online: true, updatedAt: NOW - 600_000, activeOrderId: "o2"}, {online: false, updatedAt: NOW},
    ], NOW, 90_000)).toEqual({onlineRiders: 2, busyRiders: 1});
  });
});

describe("the surge an order pays", () => {
  it("surges where the riders are busy, not across the whole city", async () => {
    // 8 riders near the centre, all on deliveries; 30 free riders 12 km away. City-wide that is
    // 8 of 38 busy (21%), no surge; around the centre it is 8 of 8.
    const db = await cityWith([{at: CENTRE, count: 8, busy: 8}, {at: FAR, count: 30, busy: 0}]);
    expect(await riderSurgeFeeNear(ON, {...CENTRE, city: "Naidupeta"}, db as never, NOW)).toBe(30);
    expect(await riderSurgeFeeNear(ON, {...FAR, city: "Naidupeta"}, db as never, NOW)).toBe(0);
  });

  it("uses the city's riders when too few are nearby, or none are filed in hexagons yet", async () => {
    const thin = await cityWith([{at: CENTRE, count: 2, busy: 2}, {at: FAR, count: 3, busy: 3}]);
    expect(await riderSurgeFeeNear(ON, {...CENTRE, city: "Naidupeta"}, thin as never, NOW)).toBe(30);
    const unfiled = await cityWith([{at: CENTRE, count: 5, busy: 4, filed: false}]);
    expect(await riderSurgeFeeNear(ON, {...CENTRE, city: "Naidupeta"}, unfiled as never, NOW)).toBe(10);
    expect(await riderSurgeFeeNear(ON, {lat: 0, lng: 0, city: "Naidupeta"}, unfiled as never, NOW)).toBe(10);
  });

  it("charges nothing when switched off, and never blocks checkout on a failed read", async () => {
    const reads = {collection: vi.fn(() => { throw new Error("offline"); })};
    expect(await riderSurgeFeeNear({}, CENTRE, reads as never, NOW)).toBe(0);
    expect(reads.collection).not.toHaveBeenCalled();
    expect(await riderSurgeFeeNear(ON, CENTRE, reads as never, NOW)).toBe(0);
  });
});

describe("Admin's surge map", () => {
  it("shows the hexagons around riders with how busy it is and the surge there", async () => {
    const db = await cityWith([{at: CENTRE, count: 8, busy: 8}, {at: FAR, count: 30, busy: 0}, {at: FAR, count: 2, busy: 0, seenAgoMs: 600_000}]);
    await db.collection("settings").doc("customer").set({riderSurgeEnabled: true});
    const map = await readRiderSurgeMap(admin, db as never, NOW);
    expect(map).toMatchObject({enabled: true, minOnline: 3, rings: 1, riders: 38, truncated: false});
    const centre = map.hexagons.find((x) => x.cell === riderHexagon(CENTRE.lat, CENTRE.lng))!;
    expect(centre).toMatchObject({here: expect.any(Number), online: 8, busy: 8, level: 3, fee: 30});
    expect(centre.corners).toHaveLength(6);
    const far = map.hexagons.find((x) => x.cell === riderHexagon(FAR.lat, FAR.lng))!;
    expect(far).toMatchObject({online: 30, busy: 0, level: 0, fee: 0});
    // Each rider's hexagon and its 6 neighbours are shown; nothing else.
    expect(map.hexagons.every((x) => x.online > 0)).toBe(true);
  });

  it("shows how busy riders are even with surge off, and is for admins only", async () => {
    const db = await cityWith([{at: CENTRE, count: 4, busy: 4}]);
    const map = await readRiderSurgeMap(admin, db as never, NOW);
    expect(map.enabled).toBe(false);
    expect(map.hexagons.find((x) => x.cell === riderHexagon(CENTRE.lat, CENTRE.lng))).toMatchObject({level: 3, fee: 0});
    await expect(readRiderSurgeMap(customer, db as never, NOW)).rejects.toThrow();
  });
});
