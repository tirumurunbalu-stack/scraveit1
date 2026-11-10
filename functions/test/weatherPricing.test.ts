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

  it("charges nothing once the rain has stopped, even after a wet hour", () => {
    // Production reading at Highway cross, 2 Nov 6:31 am: heavy rain all night,
    // 5.05 mm in the past hour, but the sky was only cloudy at checkout time.
    expect(resolveRainFee(
      {probabilityPercent: 36, quantityMm: 5.05, conditionType: "CLOUDY"},
      35, thresholds, fees,
    )).toBe(0);
  });

  it("still charges based on accumulation alone when conditionType is unavailable", () => {
    expect(resolveRainFee({probabilityPercent: 90, quantityMm: 12}, 35, thresholds, fees)).toBe(39);
  });

  it("charges the light fee for light rain now, even after a heavy hour", () => {
    // Highway cross, 2 Nov 6:49 am: light rain now, 5.05 mm over the past hour.
    expect(resolveRainFee(
      {probabilityPercent: 36, quantityMm: 5.05, conditionType: "LIGHT_RAIN"},
      35, thresholds, fees,
    )).toBe(9);
  });

  it("charges moderate and heavy fees for moderate and heavy rain now", () => {
    expect(resolveRainFee({probabilityPercent: 60, quantityMm: 0.2, conditionType: "LIGHT_TO_MODERATE_RAIN"}, 35, thresholds, fees)).toBe(19);
    expect(resolveRainFee({probabilityPercent: 90, quantityMm: 1, conditionType: "MODERATE_TO_HEAVY_RAIN"}, 35, thresholds, fees)).toBe(29);
  });
});

describe("normalizeCityKey", () => {
  it("matches the admin client's slug format", () => {
    expect(normalizeCityKey("Naidupeta")).toBe("naidupeta");
    expect(normalizeCityKey("Magunta Layout")).toBe("magunta-layout");
    expect(normalizeCityKey(undefined)).toBe("");
  });
});
