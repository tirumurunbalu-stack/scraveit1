import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_FIRESTORE"); }},
  auth: {}, db: {}, messaging: {},
}));

import {decodePolyline, distanceToRouteMeters, mapsDayKey, normalizeMapsSettings} from "../src/services/mapsGuard";
import {tileClientAllowed} from "../src/services/googleMaps";

describe("Google Maps guards", () => {
  it("defaults to on, with the suggested daily caps, and respects admin changes", () => {
    expect(normalizeMapsSettings({})).toEqual({routesEnabled: true, tilesEnabled: true, weatherEnabled: true,
      dailyLimits: {routes: 2_000, tiles: 40_000, weather: 4_000}});
    expect(normalizeMapsSettings({routesEnabled: false, dailyLimits: {routes: 500, tiles: -3}})).toMatchObject({
      routesEnabled: false, dailyLimits: {routes: 500, tiles: 40_000, weather: 4_000}});
  });

  it("tells a rider still on the line from one who has left it", () => {
    // Google's documented sample polyline: (38.5,-120.2) -> (40.7,-120.95) -> (43.252,-126.453).
    const route = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(route[0]).toEqual({lat: 38.5, lng: -120.2});
    expect(route[2]).toEqual({lat: 43.252, lng: -126.453});
    const nellore = [{lat: 14.4426, lng: 79.9865}, {lat: 14.4526, lng: 79.9865}];
    expect(distanceToRouteMeters({lat: 14.4476, lng: 79.9866}, nellore)).toBeLessThan(20);
    expect(distanceToRouteMeters({lat: 14.4476, lng: 79.9900}, nellore)).toBeGreaterThan(300);
  });

  it("uses the India calendar day and slows down a client asking for too many tiles", () => {
    expect(mapsDayKey(Date.parse("2026-10-04T20:00:00Z"))).toBe("2026-10-05");
    const now = Date.parse("2026-10-04T10:00:00Z");
    let allowed = 0;
    for (let i = 0; i < 320; i++) if (tileClientAllowed("203.0.113.9", now)) allowed++;
    expect(allowed).toBe(300);
    expect(tileClientAllowed("203.0.113.9", now + 60_000)).toBe(true);
  });
});
