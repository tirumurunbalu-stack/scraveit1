import {describe, expect, it} from "vitest";
import {latestStoreHoursEvent, parseClock, storeHoursChange} from "../src/domain/storeHours";

const ist = (s: string) => Date.parse(s + "+05:30");

describe("store hours", () => {
  it("reads the time formats stores use", () => {
    expect(parseClock("11:00")).toBe(660);
    expect(parseClock("23:00")).toBe(1380);
    expect(parseClock("11:00am")).toBe(660);
    expect(parseClock("10:00pm")).toBe(1320);
    expect(parseClock("11:00 PM")).toBe(1380);
    expect(parseClock("11 am")).toBe(660);
    expect(parseClock("12:30 am")).toBe(30);
    expect(parseClock("12 pm")).toBe(720);
    expect(parseClock("11")).toBeNull();
    expect(parseClock("late")).toBeNull();
    expect(parseClock("")).toBeNull();
  });

  const waffle = {opensAt: "11:00am", opensUntil: "10:00pm"};

  it("closes at closing time and opens at opening time", () => {
    expect(latestStoreHoursEvent(waffle, ist("2026-11-13T08:07:00"))).toMatchObject({key: "2026-11-12:close", open: false});
    expect(latestStoreHoursEvent(waffle, ist("2026-11-13T11:00:30"))).toMatchObject({key: "2026-11-13:open", open: true});
    expect(latestStoreHoursEvent(waffle, ist("2026-11-13T21:59:00"))).toMatchObject({key: "2026-11-13:open", open: true});
    expect(latestStoreHoursEvent(waffle, ist("2026-11-13T22:00:10"))).toMatchObject({key: "2026-11-13:close", open: false});
  });

  it("applies each opening or closing once, so a manual switch holds until the next one", () => {
    const now = ist("2026-11-13T12:00:00");
    expect(storeHoursChange(waffle, "", now)).toMatchObject({open: true});
    // Already opened at 11; the owner closed it by hand at 11:30: nothing changes until 10 pm.
    expect(storeHoursChange({...waffle, open: false}, "2026-11-13:open", now)).toBeNull();
    expect(storeHoursChange({...waffle, open: false}, "2026-11-13:open", ist("2026-11-13T22:01:00"))).toMatchObject({open: false});
    // Opened by hand at 8 am, before opening time: stays open; 11 am open is then a no-op on the switch.
    expect(storeHoursChange({...waffle, open: true}, "2026-11-12:close", ist("2026-11-13T08:00:00"))).toBeNull();
  });

  it("handles hours past midnight", () => {
    const late = {opensAt: "18:00", opensUntil: "02:00"};
    expect(latestStoreHoursEvent(late, ist("2026-11-13T01:00:00"))).toMatchObject({key: "2026-11-12:open", open: true});
    expect(latestStoreHoursEvent(late, ist("2026-11-13T02:05:00"))).toMatchObject({key: "2026-11-12:close", open: false});
    expect(latestStoreHoursEvent(late, ist("2026-11-13T18:01:00"))).toMatchObject({key: "2026-11-13:open", open: true});
  });

  it("stays closed on days the store doesn't open", () => {
    // 15 Nov 2026 is a Sunday.
    const noSunday = {opensAt: "11:00", opensUntil: "22:00", openDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]};
    expect(latestStoreHoursEvent(noSunday, ist("2026-11-15T12:00:00"))).toMatchObject({key: "2026-11-14:close", open: false});
    expect(latestStoreHoursEvent(noSunday, ist("2026-11-16T11:01:00"))).toMatchObject({key: "2026-11-16:open", open: true});
  });

  it("does nothing without both times, with equal times, or for archived stores", () => {
    const now = ist("2026-11-13T12:00:00");
    expect(storeHoursChange({opensUntil: "10:00pm"}, "", now)).toBeNull();
    expect(storeHoursChange({opensAt: "", opensUntil: ""}, "", now)).toBeNull();
    expect(storeHoursChange({opensAt: "09:00", opensUntil: "09:00"}, "", now)).toBeNull();
    expect(storeHoursChange({...waffle, archived: true}, "", now)).toBeNull();
  });
});
