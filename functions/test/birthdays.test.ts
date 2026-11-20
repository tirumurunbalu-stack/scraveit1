import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}, messaging: {}, db: {}}));
vi.mock("../src/services/notifications", () => ({notifyBirthday: vi.fn()}));

import {birthdayCopy, birthdaySlotFor, istDay, monthDaysFor} from "../src/services/birthdays";

const IST = (iso: string) => Date.parse(iso + "+05:30");

describe("birthday greetings", () => {
  it("uses the India date, not UTC", () => {
    // 00:30 IST on 21 Nov is still 20 Nov in UTC.
    expect(istDay(IST("2026-11-21T00:30:00")).monthDay).toBe("11-21");
    expect(istDay(IST("2026-11-21T00:30:00")).startOfDay).toBe(IST("2026-11-21T00:00:00"));
  });
  it("greets 29 Feb birthdays on 28 Feb in non-leap years only", () => {
    expect(monthDaysFor(IST("2027-02-28T09:00:00"))).toEqual(["02-28", "02-29"]);
    expect(monthDaysFor(IST("2028-02-28T09:00:00"))).toEqual(["02-28"]);
    expect(monthDaysFor(IST("2028-02-29T09:00:00"))).toEqual(["02-29"]);
  });
  it("maps 9 am, 1 pm and 6 pm India time to the three slots", () => {
    expect(birthdaySlotFor(IST("2026-11-20T09:00:05"))).toBe("morning");
    expect(birthdaySlotFor(IST("2026-11-20T13:00:05"))).toBe("afternoon");
    expect(birthdaySlotFor(IST("2026-11-20T18:00:05"))).toBe("evening");
    expect(birthdaySlotFor(IST("2026-11-20T11:00:00"))).toBe(null);
  });
  it("writes a greeting with no offer", () => {
    const morning = birthdayCopy("morning", "Balaji");
    expect(morning.title).toBe("🎂 Happy birthday, Balaji!");
    for (const slot of ["morning", "afternoon", "evening"] as const) {
      const copy = birthdayCopy(slot, "");
      expect(copy.title + copy.body).not.toMatch(/₹|% off|free|offer|coupon/i);
      expect(copy.title).not.toContain(", ");
    }
  });
});
