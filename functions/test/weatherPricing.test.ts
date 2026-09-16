import {describe, expect, it} from "vitest";
import {normalizeCityKey, resolveRainFee} from "../src/domain/weatherPricing";

const thresholds = {light: 0.1, moderate: 1, heavy: 4, severe: 10};
const fees = {light: 9, moderate: 19, heavy: 29, severe: 39};

describe("resolveRainFee", () => {
  it("charges nothing below the minimum probability even if rain is reported", () => {
    expect(resolveRainFee({probabilityPercent: 20, quantityMm: 15}, 35, thresholds, fees)).toBe(0);
  });

  it("charges nothing when there is no measurable precipitation", () => {
    expect(resolveRainFee({probabilityPercent: 80, quantityMm: 0}, 35, thresholds, fees)).toBe(0);
  });

  it("picks the light tier at the light threshold", () => {
    expect(resolveRainFee({probabilityPercent: 50, quantityMm: 0.1}, 35, thresholds, fees)).toBe(9);
  });

  it("picks the highest matching tier", () => {
    expect(resolveRainFee({probabilityPercent: 90, quantityMm: 12}, 35, thresholds, fees)).toBe(39);
  });

  it("picks the moderate tier between moderate and heavy thresholds", () => {
    expect(resolveRainFee({probabilityPercent: 60, quantityMm: 2}, 35, thresholds, fees)).toBe(19);
  });

  it("charges the severe tier for an active thunderstorm even with negligible hourly accumulation", () => {
    // Reproduces the real production reading that exposed the gap: Google's
    // currentConditions reported only 0.08mm accumulated over the last hour
    // (below even the light threshold) while weatherCondition.type still
    // said a thunderstorm was actively happening right now.
    expect(resolveRainFee(
      {probabilityPercent: 35, quantityMm: 0.08, conditionType: "THUNDERSTORM"},
      35, thresholds, fees,
    )).toBe(39);
  });

  it("charges the light tier for a live light-rain condition with no accumulation yet", () => {
    expect(resolveRainFee(
      {probabilityPercent: 10, quantityMm: 0, conditionType: "LIGHT_RAIN"},
      35, thresholds, fees,
    )).toBe(9);
  });

  it("does not charge for snow-only conditions", () => {
    expect(resolveRainFee(
      {probabilityPercent: 90, quantityMm: 0, conditionType: "HEAVY_SNOW"},
      35, thresholds, fees,
    )).toBe(0);
  });

  it("does not charge for clear conditions regardless of a stray accumulated reading", () => {
    expect(resolveRainFee(
      {probabilityPercent: 90, quantityMm: 0, conditionType: "CLEAR"},
      35, thresholds, fees,
    )).toBe(0);
  });

  it("still charges based on accumulation alone when conditionType is unavailable", () => {
    expect(resolveRainFee({probabilityPercent: 90, quantityMm: 12}, 35, thresholds, fees)).toBe(39);
  });

  it("takes the worse of the two signals when accumulation implies a higher tier", () => {
    expect(resolveRainFee(
      {probabilityPercent: 90, quantityMm: 12, conditionType: "LIGHT_RAIN"},
      35, thresholds, fees,
    )).toBe(39);
  });
});

describe("normalizeCityKey", () => {
  it("matches the admin client's slug format", () => {
    expect(normalizeCityKey("Naidupeta")).toBe("naidupeta");
    expect(normalizeCityKey("Magunta Layout")).toBe("magunta-layout");
    expect(normalizeCityKey(undefined)).toBe("");
  });
});
