import {describe, expect, it} from "vitest";
import {
  atCampus, campusZoneFromPlace, campusZoneWithGates, learnCampusGate, partnerAtCampusNow, placesContainingPin, type CampusZone,
} from "../src/domain/campus";
import {
  advanceTrackingEvidence,
  proximityRequirement,
  type TrackingEvidenceRecord,
  type TrackingFix,
} from "../src/domain/tracking";
import {lookupCampusAt} from "../src/services/campus";

const M = 1 / 111_320; // degrees of latitude per metre
const ID = (n: number) => `ChIJ_test_place_${n}xxxxx`;

// A 1 km x 1 km campus; the customer's hostel pin is deep inside, the gate is on the south edge.
const CAMPUS: CampusZone = {placeId: ID(1), name: "Test University", south: 13.6200, west: 79.4000, north: 13.6290, east: 79.4093};
const GATE = {lat: 13.6200, lng: 79.4046};
const PIN = {lat: 13.6280, lng: 79.4046};
const metersFromPin = (lat: number) => Math.abs(PIN.lat - lat) / M;

function fix(updatedAt: number, lat: number, lng = GATE.lng, accuracy = 15): TrackingFix {
  return {orderId: "SV-CAMPUS", customerId: "customer-1", riderId: "partner-1", lat, lng, accuracy, updatedAt, phase: "delivery", status: "live"};
}

type Step = {t: number; lat: number; accuracy?: number};
function ride(steps: Step[], campus: CampusZone | null = CAMPUS) {
  let record: TrackingEvidenceRecord | null = null;
  let status: "Out for delivery" | "Near you" = "Out for delivery";
  let reachedEvent = "";
  let arrived: {t: number; campus: boolean} | null = null;
  steps.forEach((step, i) => {
    if (arrived) return;
    const f = fix(1_000_000 + step.t, step.lat, GATE.lng, step.accuracy);
    const distance = metersFromPin(step.lat);
    record = advanceTrackingEvidence(record, {
      eventId: `e${i}`, fix: f, distanceMeters: distance,
      requirement: proximityRequirement(status, distance), serverNow: f.updatedAt + 50, campus,
    });
    if (record?.campusReachedEventId === `e${i}` && !reachedEvent) reachedEvent = `e${i}@${step.t}`;
    const pending = record?.pendingTransition;
    if (pending?.status === "Near you") { status = "Near you"; record = {...record!, pendingTransition: undefined}; }
    if (pending?.status === "Arrived") arrived = {t: step.t, campus: pending.campus === true};
  });
  return {record, reachedEvent, arrived: arrived as {t: number; campus: boolean} | null};
}

const wander = (i: number) => [0, 12, -9, 18, -15, 6, 25, -20][i % 8] * M;
/** Approach from 1.1 km south of the pin (300 m outside the gate), then stand at the gate for `standMs`. */
function approachThenStand(standMs: number): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i <= 10; i++) steps.push({t: i * 3000, lat: GATE.lat - (300 - i * 30) * M});
  for (let t = 33_000; t <= 33_000 + standMs; t += 3000) steps.push({t, lat: GATE.lat + wander(t / 3000)});
  return steps;
}

describe("campus size per place", () => {
  const nbkr = {lat: 14.02755, lng: 80.0212502};
  // What Google gives NBKR: no boundary, just its generic ~300 m box around the point.
  const generic = {
    types: ["educational_institution", "point_of_interest", "establishment"],
    location: {latitude: nbkr.lat, longitude: nbkr.lng},
    viewport: {low: {latitude: nbkr.lat - 150 * M, longitude: nbkr.lng - 0.00139}, high: {latitude: nbkr.lat + 150 * M, longitude: nbkr.lng + 0.00139}},
  };
  const span = (z: CampusZone) => Math.round((z.north - z.south) / M);

  it("a college Google tags only as educational_institution is a campus, sized like a college (1 km), not 300 m", () => {
    const zone = campusZoneFromPlace({placeId: ID(9), name: "NBKR Institute"}, generic)!;
    expect(zone.name).toBe("NBKR Institute");
    expect(span(zone)).toBe(1000);
  });
  it("a school or hospital with only the generic box gets a smaller start", () => {
    expect(span(campusZoneFromPlace({placeId: ID(8), name: "School"}, {...generic, types: ["school"]})!)).toBe(500);
    expect(span(campusZoneFromPlace({placeId: ID(7), name: "Hospital"}, {...generic, types: ["hospital"]})!)).toBe(600);
  });
  it("uses Google's real boundary when it has one", () => {
    const real = {...generic, viewport: {low: {latitude: nbkr.lat - 400 * M, longitude: nbkr.lng - 0.003}, high: {latitude: nbkr.lat + 400 * M, longitude: nbkr.lng + 0.003}}};
    expect(span(campusZoneFromPlace({placeId: ID(9), name: "NBKR"}, real)!)).toBe(800);
  });
  it("learns a gate where an order was handed over outside the box, and the next order's box takes it in", () => {
    const zone = campusZoneFromPlace({placeId: ID(9), name: "NBKR"}, generic)!;
    const gate = {lat: zone.south - 300 * M, lng: nbkr.lng, accuracy: 20};
    expect(atCampus(gate, zone)).toBe(false);
    const gates = learnCampusGate(zone, [], gate, 1)!;
    expect(gates).toHaveLength(1);
    expect(atCampus(gate, campusZoneWithGates(zone, gates))).toBe(true);
    // Same spot again, a handover inside the box, a blurry reading or a far-away spot: nothing new.
    expect(learnCampusGate(zone, gates, {...gate, lat: gate.lat + 20 * M}, 2)).toBeNull();
    expect(learnCampusGate(zone, [], {...nbkr, accuracy: 10}, 2)).toBeNull();
    expect(learnCampusGate(zone, [], {...gate, accuracy: 200}, 2)).toBeNull();
    expect(learnCampusGate(zone, [], {...gate, lat: nbkr.lat - 3000 * M}, 2)).toBeNull();
  });
});

describe("Google says inside, not near", () => {
  it("keeps only places the pin is inside", () => {
    const places = placesContainingPin({
      areas: [
        {place_id: ID(1), display_name: {text: "SV University"}, containment: "WITHIN"},
        {place_id: ID(2), display_name: {text: "Hospital campus"}, containment: "OUTSKIRTS"},
        {place_id: ID(3), display_name: {text: "XYZ Hospital"}, containment: "NEAR"},
      ],
      landmarks: [
        {place_id: ID(4), display_name: {text: "City Hospital"}, spatial_relationship: "ACROSS_THE_ROAD", types: ["hospital"]},
        {place_id: ID(5), display_name: {text: "Medical College"}, spatial_relationship: "WITHIN", types: ["university"]},
        {place_id: ID(6), display_name: {text: "Clinic"}, spatial_relationship: "BESIDE", types: ["hospital"]},
      ],
    });
    expect(places.map((p) => p.name)).toEqual(["SV University", "Hospital campus", "Medical College"]);
    expect(placesContainingPin(null)).toEqual([]);
    expect(placesContainingPin({areas: [{place_id: ID(3), containment: "NEAR"}]})).toEqual([]);
  });

  it("is a campus only for college, school or hospital types", () => {
    const viewport = {low: {latitude: 13.62, longitude: 79.40}, high: {latitude: 13.629, longitude: 79.4093}};
    expect(campusZoneFromPlace({placeId: ID(1), name: "U"}, {types: ["university", "point_of_interest"], viewport}))
      .toMatchObject({south: 13.62, north: 13.629});
    expect(campusZoneFromPlace({placeId: ID(1), name: "H"}, {types: ["hospital"], location: {latitude: 13.62, longitude: 79.4}}))
      .not.toBeNull();
    expect(campusZoneFromPlace({placeId: ID(1), name: "Mall"}, {types: ["shopping_mall"], viewport})).toBeNull();
    expect(campusZoneFromPlace({placeId: ID(1), name: "Area"}, {types: ["hospital"],
      viewport: {low: {latitude: 13.5, longitude: 79.3}, high: {latitude: 13.7, longitude: 79.5}}})).toBeNull();
  });

  it("counts the gate road (150 m outside the box) as at the campus, not 400 m away", () => {
    expect(atCampus({lat: GATE.lat - 100 * M, lng: GATE.lng}, CAMPUS)).toBe(true);
    expect(atCampus({lat: GATE.lat - 400 * M, lng: GATE.lng}, CAMPUS)).toBe(false);
  });
});

describe("campus orders", () => {
  it("tells the customer when the partner reaches the campus (once)", () => {
    const {reachedEvent, arrived} = ride(approachThenStand(30_000));
    expect(reachedEvent).toMatch(/@(15000|18000)$/); // 150 m from the gate
    expect(arrived).toBeNull();
  });

  it("waiting 3 minutes at the gate opens the code box (Arrived, campus)", () => {
    const {arrived} = ride(approachThenStand(200_000));
    expect(arrived).not.toBeNull();
    expect(arrived!.campus).toBe(true);
    // the wait starts once standing at the gate: 3 minutes later, not before
    expect(arrived!.t).toBeGreaterThanOrEqual(33_000 + 180_000 - 3000);
    expect(arrived!.t).toBeLessThan(33_000 + 180_000 + 6000);
  });

  it("does not open at 2 min 50 s", () => {
    expect(ride(approachThenStand(170_000)).arrived).toBeNull();
  });

  it("partner allowed inside rides on: normal 100 m Arrived, no waiting message", () => {
    const steps: Step[] = [];
    for (let i = 0; i <= 10; i++) steps.push({t: i * 3000, lat: GATE.lat - (300 - i * 30) * M});
    // through the gate and across the campus at 4 m/s to the hostel
    for (let i = 1; i <= 80; i++) steps.push({t: 30_000 + i * 3000, lat: Math.min(PIN.lat, GATE.lat + i * 12 * M)});
    const {arrived, reachedEvent} = ride(steps);
    expect(reachedEvent).not.toBe("");
    expect(arrived).not.toBeNull();
    expect(arrived!.campus).toBe(false);
  });

  it("traffic stop away from the campus does not count", () => {
    // stuck 5 minutes, 400 m outside the gate
    const steps: Step[] = Array.from({length: 100}, (_, i) => ({t: i * 3000, lat: GATE.lat - 400 * M + wander(i)}));
    const {arrived, reachedEvent} = ride(steps);
    expect(arrived).toBeNull();
    expect(reachedEvent).toBe("");
  });

  it("normal orders never use the campus rules", () => {
    const {arrived, reachedEvent, record} = ride(approachThenStand(300_000), null);
    expect(arrived).toBeNull();
    expect(reachedEvent).toBe("");
    expect(record!.stillSince).toBeUndefined();
  });

  it("normal 100 m arrival for a normal order is unchanged", () => {
    const steps: Step[] = [{t: 0, lat: PIN.lat - 60 * M}, {t: 3000, lat: PIN.lat - 55 * M}];
    const {arrived} = ride(steps, null);
    expect(arrived).toEqual({t: 3000, campus: false});
  });
});

describe("asking Google", () => {
  function fakeFetch(responses: Record<string, unknown>, calls: string[]) {
    return (async (url: string) => {
      calls.push(url.split("?")[0]);
      const key = Object.keys(responses).find((k) => url.includes(k))!;
      return {ok: true, status: 200, json: async () => responses[key]};
    }) as unknown as typeof fetch;
  }

  it("finds the campus the pin is inside", async () => {
    const calls: string[] = [];
    const result = await lookupCampusAt(13.628, 79.4046, "k", fakeFetch({
      "geocode/json": {status: "OK", address_descriptor: {areas: [
        {place_id: ID(7), display_name: {text: "Hostel Block C"}, containment: "WITHIN"},
        {place_id: ID(1), display_name: {text: "Test University"}, containment: "WITHIN"},
      ]}},
      [ID(7)]: {types: ["lodging"]},
      [ID(1)]: {types: ["university"], viewport: {low: {latitude: 13.62, longitude: 79.40}, high: {latitude: 13.629, longitude: 79.4093}}},
    }, calls));
    expect(result.campus?.name).toBe("Test University");
    expect(result.calls).toBe(3);
  });

  it("a house near a hospital is not a campus (one call only)", async () => {
    const calls: string[] = [];
    const result = await lookupCampusAt(13.6, 79.4, "k", fakeFetch({
      "geocode/json": {status: "OK", address_descriptor: {areas: [{place_id: ID(3), display_name: {text: "XYZ Hospital"}, containment: "NEAR"}]}},
    }, calls));
    expect(result).toEqual({campus: null, calls: 1});
  });

  it("throws when Google refuses (order stays on normal rules)", async () => {
    const refused = (async () => ({ok: true, status: 200, json: async () => ({status: "REQUEST_DENIED"})})) as unknown as typeof fetch;
    await expect(lookupCampusAt(13.6, 79.4, "k", refused)).rejects.toThrow(/REQUEST_DENIED/);
  });
});

describe("customer message for waiting at the gate", () => {
  it("knows an Arrived that came from waiting at the campus", async () => {
    const {arrivedAtCampusGate} = await import("../src/services/notifications");
    const order = (proof: string) => ({statusHistory: {
      a: {status: "Out for delivery", at: 1, actorId: "p", actorRole: "rider"},
      b: {status: "Arrived", at: 2, actorId: "p", actorRole: "system", proof},
    }}) as never;
    expect(arrivedAtCampusGate(order("campus:e9"))).toBe(true);
    expect(arrivedAtCampusGate(order("tracking:e9"))).toBe(false);
  });
});

describe("campus: the partner's own swipe at the gate", () => {
  const NOW = 2_000_000_000_000;
  it("opens the code box at once when they are at the campus (customer already waiting at the gate)", () => {
    expect(partnerAtCampusNow({...GATE, accuracy: 20, updatedAt: NOW - 4_000}, CAMPUS, NOW)).toBe(true);
    // Gates sit on the boundary road: 100 m outside the box still counts.
    expect(partnerAtCampusNow({lat: GATE.lat - 100 * M, lng: GATE.lng, accuracy: 20, updatedAt: NOW - 4_000}, CAMPUS, NOW)).toBe(true);
  });
  it("does nothing when they are not at the campus yet", () => {
    expect(partnerAtCampusNow({lat: GATE.lat - 600 * M, lng: GATE.lng, accuracy: 20, updatedAt: NOW - 4_000}, CAMPUS, NOW)).toBe(false);
  });
  it("does nothing on an old, future-dated or vague GPS reading", () => {
    expect(partnerAtCampusNow({...GATE, accuracy: 20, updatedAt: NOW - 61_000}, CAMPUS, NOW)).toBe(false);
    expect(partnerAtCampusNow({...GATE, accuracy: 20, updatedAt: NOW + 6_000}, CAMPUS, NOW)).toBe(false);
    expect(partnerAtCampusNow({...GATE, accuracy: 120, updatedAt: NOW - 4_000}, CAMPUS, NOW)).toBe(false);
  });
});
