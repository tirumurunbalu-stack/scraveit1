import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}}));

const {istParts, orderTimeFor, dueOn, upcomingDates, planDueNow, validatePlan, weekdayOf} = await import("../src/services/mealPlans");

const ist = (s: string) => Date.parse(`${s}+05:30`);
const plan = {active: true, days: [1, 2, 3, 4, 5, 6], windowStart: "12:30", windowEnd: "13:30"};

describe("daily meal plans", () => {
  it("works in India time", () => {
    expect(istParts(ist("2026-10-12T00:10:00"))).toMatchObject({date: "2026-10-12", weekday: 1, minutes: 10});
    expect(weekdayOf("2026-10-11")).toBe(0);
  });
  it("places the order 45 minutes before the delivery window", () => {
    expect(orderTimeFor("2026-10-12", "12:30")).toBe(ist("2026-10-12T11:45:00"));
  });
  it("is due only on plan days, in the ordering slot", () => {
    expect(planDueNow(plan, ist("2026-10-12T11:44:00"))).toBeNull();
    expect(planDueNow(plan, ist("2026-10-12T11:45:00"))).toBe("2026-10-12");
    expect(planDueNow(plan, ist("2026-10-12T12:20:00"))).toBe("2026-10-12");
    expect(planDueNow(plan, ist("2026-10-12T12:30:00"))).toBeNull();
    expect(planDueNow(plan, ist("2026-10-11T11:50:00"))).toBeNull(); // Sunday
    expect(planDueNow({...plan, active: false}, ist("2026-10-12T11:50:00"))).toBeNull();
  });
  it("delivers on chosen days, not on skipped days or after the end", () => {
    const sub = {status: "active", startDate: "2026-10-12", endDate: "2026-10-25", days: [1, 3, 5], skips: ["2026-10-14"]};
    expect(dueOn(sub, "2026-10-12")).toBe(true);
    expect(dueOn(sub, "2026-10-13")).toBe(false);
    expect(dueOn(sub, "2026-10-14")).toBe(false);
    expect(dueOn(sub, "2026-10-16")).toBe(true);
    expect(dueOn(sub, "2026-10-26")).toBe(false);
    expect(dueOn({...sub, status: "paused"}, "2026-10-12")).toBe(false);
    expect(upcomingDates(sub, "2026-10-12", 4)).toEqual(["2026-10-12", "2026-10-14", "2026-10-16", "2026-10-19"]);
  });
  it("rejects windows that are too short, too long or too early", () => {
    const base = {restaurantId: "r", name: "Lunch", description: "", meal: "lunch" as const, menuItemId: "m", days: [1], weeklyMenu: {}, maxPerDay: 20, active: true};
    expect(() => validatePlan({...base, windowStart: "12:30", windowEnd: "12:45"})).toThrow();
    expect(() => validatePlan({...base, windowStart: "06:00", windowEnd: "07:00"})).toThrow();
    expect(() => validatePlan({...base, windowStart: "12:30", windowEnd: "13:30", days: [9]})).toThrow();
    expect(() => validatePlan({...base, windowStart: "12:30", windowEnd: "13:30"})).not.toThrow();
  });
});
