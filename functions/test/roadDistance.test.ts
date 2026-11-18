import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore(), db: {}, auth: {}};
});

import {estimatedRoadKm, roadDistanceKm, roadPairKey, roundKm} from "../src/services/roadDistance";

describe("road distance for the delivery fee", () => {
  it("rounds to 0.1 km and estimates straight × 1.3 without Google", () => {
    expect(roundKm(8.06)).toBe(8.1);
    expect(estimatedRoadKm(5.88)).toBe(7.6);
  });

  it("keys one store + address pair the same at checkout and order", () => {
    expect(roadPairKey("store1", {lat: 13.91694031, lng: 79.84150589})).toBe("store1_13.91694_79.84151");
  });

  it("falls back to the estimate when no Maps key is set", async () => {
    const result = await roadDistanceKm({id: "s", lat: 13.917611, lng: 79.895976}, {lat: 13.9169403, lng: 79.8415058}, 5.88);
    expect(result).toEqual({km: 7.6, source: "estimate"});
  });
});
