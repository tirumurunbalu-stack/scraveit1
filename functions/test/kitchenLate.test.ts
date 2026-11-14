import {describe, expect, it} from "vitest";
import {kitchenPrepMinutes, lateReminderDue} from "../src/domain/kitchenLate";

const ACCEPT = 1_000_000_000_000;
const MIN = 60_000;
function order(status: string, items: {quantity: number; free?: true}[]) {
  return {status, items, statusHistory: {a: {status: "Accepted", at: ACCEPT}}, createdAt: ACCEPT - MIN, updatedAt: ACCEPT} as never;
}

describe("kitchen late reminders", () => {
  it("uses the app's 15 / 20 minute timer, free items not counted", () => {
    expect(kitchenPrepMinutes(order("Accepted", [{quantity: 2}]))).toBe(15);
    expect(kitchenPrepMinutes(order("Accepted", [{quantity: 4}]))).toBe(20);
    expect(kitchenPrepMinutes(order("Accepted", [{quantity: 1}, {quantity: 1}, {quantity: 1}]))).toBe(20);
    expect(kitchenPrepMinutes(order("Accepted", [{quantity: 2}, {quantity: 5, free: true}]))).toBe(15);
  });
  it("says it at the deadline, then every minute until ready (stops after an hour)", () => {
    const o = order("Preparing", [{quantity: 1}]);
    expect(lateReminderDue(o, ACCEPT + 14 * MIN)).toBeNull();
    expect(lateReminderDue(o, ACCEPT + 15 * MIN)).toBe(0);
    expect(lateReminderDue(o, ACCEPT + 15.5 * MIN)).toBe(0);
    expect(lateReminderDue(o, ACCEPT + 16 * MIN)).toBe(1);
    expect(lateReminderDue(o, ACCEPT + 25.2 * MIN)).toBe(10);
    expect(lateReminderDue(o, ACCEPT + 74.9 * MIN)).toBe(59);
    expect(lateReminderDue(o, ACCEPT + 75 * MIN)).toBeNull();
  });
  it("stops once the order is ready", () => {
    expect(lateReminderDue(order("Ready for pickup", [{quantity: 1}]), ACCEPT + 16 * MIN)).toBeNull();
  });
});
