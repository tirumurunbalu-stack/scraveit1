import {describe, expect, it} from "vitest";
import {parseTilePath} from "../src/services/googleMaps";

describe("Google map tile paths", () => {
  it("accepts tiles over India at app zooms, day or night", () => {
    // Nellore, zoom 16.
    expect(parseTilePath("/maptile/day/16/47308/30387")).toEqual({style: "day", z: 16, x: 47308, y: 30387});
    expect(parseTilePath("/maptile/night/16/47308/30387.png")).toMatchObject({style: "night"});
  });
  it("refuses tiles outside India, odd zooms and malformed paths", () => {
    expect(parseTilePath("/maptile/day/16/0/0")).toBeNull();
    expect(parseTilePath("/maptile/day/2/2/1")).toBeNull();
    expect(parseTilePath("/maptile/sepia/16/47308/30387")).toBeNull();
    expect(parseTilePath("/maptile/day/16/99999999/1")).toBeNull();
  });
});
