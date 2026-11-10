import {describe, expect, it} from "vitest";
import {cleanCity} from "../src/services/reels";

describe("public reels", () => {
  it("keeps only a city name, never an address or position", () => {
    expect(cleanCity("  Nellore ")).toBe("Nellore");
    expect(cleanCity("Vedayapalem, 524004")).toBe("Vedayapalem");
    expect(cleanCity("14.44,79.98")).toBe("");
    expect(cleanCity("A".repeat(80))).toHaveLength(40);
  });
});
