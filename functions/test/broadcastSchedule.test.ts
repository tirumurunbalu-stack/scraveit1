import {describe, expect, it} from "vitest";
import {computeNextBroadcastOccurrence} from "../src/domain/broadcastSchedule";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("computeNextBroadcastOccurrence", () => {
  it("never recurs when type is none or missing", () => {
    const at = Date.UTC(2026, 0, 5, 12, 0, 0);
    expect(computeNextBroadcastOccurrence(at, {type: "none"})).toBeNull();
    expect(computeNextBroadcastOccurrence(at, null)).toBeNull();
    expect(computeNextBroadcastOccurrence(at, undefined)).toBeNull();
  });

  it("adds exactly one day for daily recurrence, preserving time-of-day", () => {
    const at = Date.UTC(2026, 0, 5, 18, 30, 0); // an arbitrary IST evening moment
    expect(computeNextBroadcastOccurrence(at, {type: "daily"})).toBe(at + DAY_MS);
  });

  it("adds the configured interval for custom recurrence", () => {
    const at = Date.UTC(2026, 0, 5, 9, 0, 0);
    expect(computeNextBroadcastOccurrence(at, {type: "custom", intervalDays: 3})).toBe(at + 3 * DAY_MS);
  });

  it("falls back to a 1-day interval when intervalDays is missing or invalid", () => {
    const at = Date.UTC(2026, 0, 5, 9, 0, 0);
    expect(computeNextBroadcastOccurrence(at, {type: "custom"})).toBe(at + DAY_MS);
    expect(computeNextBroadcastOccurrence(at, {type: "custom", intervalDays: 0})).toBe(at + DAY_MS);
    expect(computeNextBroadcastOccurrence(at, {type: "custom", intervalDays: -2})).toBe(at + DAY_MS);
  });

  it("finds the next matching IST weekday for weekly recurrence", () => {
    // 2026-01-05 12:00 UTC = 2026-01-05 17:30 IST, a Monday (IST weekday 1).
    const monday = Date.UTC(2026, 0, 5, 12, 0, 0);
    // Next Wednesday (IST weekday 3) at the same absolute time-of-day.
    const wednesday = monday + 2 * DAY_MS;
    expect(computeNextBroadcastOccurrence(monday, {type: "weekly", days: [3]})).toBe(wednesday);
  });

  it("wraps to the following week when no later day matches this week", () => {
    // Friday (IST weekday 5); only Monday (1) is selected, so it must wrap forward.
    const friday = Date.UTC(2026, 0, 9, 12, 0, 0);
    const nextMonday = friday + 3 * DAY_MS;
    expect(computeNextBroadcastOccurrence(friday, {type: "weekly", days: [1]})).toBe(nextMonday);
  });

  it("picks the closest of several selected days", () => {
    const monday = Date.UTC(2026, 0, 5, 12, 0, 0);
    const friday = monday + 4 * DAY_MS;
    expect(computeNextBroadcastOccurrence(monday, {type: "weekly", days: [5, 3, 0]})).toBe(monday + 2 * DAY_MS);
    expect(monday + 2 * DAY_MS).toBeLessThan(friday);
  });

  it("returns null for weekly recurrence with no valid days configured", () => {
    const at = Date.UTC(2026, 0, 5, 12, 0, 0);
    expect(computeNextBroadcastOccurrence(at, {type: "weekly", days: []})).toBeNull();
    expect(computeNextBroadcastOccurrence(at, {type: "weekly"})).toBeNull();
  });

  it("treats an invalid current schedule as non-recurring", () => {
    expect(computeNextBroadcastOccurrence(0, {type: "daily"})).toBeNull();
    expect(computeNextBroadcastOccurrence(Number.NaN, {type: "daily"})).toBeNull();
  });
});
