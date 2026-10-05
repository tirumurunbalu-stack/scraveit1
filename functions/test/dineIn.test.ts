import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, db: {}, auth: {}}));
vi.mock("../src/services/notifications", () => ({notifyRestaurantDineIn: vi.fn(), notifyUserDineIn: vi.fn()}));

const {istMinutes, normalizeDineIn, slotAllowed} = await import("../src/services/dineIn");

const istAt = (iso: string) => new Date(`${iso}+05:30`).getTime();

describe("dine-in settings", () => {
  it("is off until it is switched on and has tables", () => {
    expect(normalizeDineIn({enabled: true, tables: []}).enabled).toBe(false);
    expect(normalizeDineIn({enabled: true, tables: [{id: "1", seats: 4}]}).enabled).toBe(true);
    expect(normalizeDineIn(undefined).enabled).toBe(false);
  });
  it("cleans table ids, seats and hours", () => {
    const settings = normalizeDineIn({enabled: true, tables: [{id: "T 1/a", seats: 99}], openFrom: "25:00", slotMinutes: 7});
    expect(settings.tables[0]).toEqual({id: "T1a", label: "Table T1a", seats: 30});
    expect(settings.openFrom).toBe("12:00");
    expect(settings.slotMinutes).toBe(30);
    expect(settings.autoAccept).toBe(true);
  });
});

describe("booking times", () => {
  const settings = normalizeDineIn({enabled: true, tables: [{id: "1"}], openFrom: "12:00", openTo: "22:30", slotMinutes: 30});
  const now = istAt("2026-10-04T10:00:00");
  it("reads India time", () => {
    expect(istMinutes(istAt("2026-10-04T19:30:00"))).toBe(19 * 60 + 30);
  });
  it("accepts a slot on the grid inside dine-in hours", () => {
    expect(slotAllowed(settings, istAt("2026-10-04T19:30:00"), now)).toBeNull();
    expect(slotAllowed(settings, istAt("2026-10-04T22:00:00"), now)).toBeNull();
  });
  it("refuses off-grid, out-of-hours, too-soon and too-far slots", () => {
    expect(slotAllowed(settings, istAt("2026-10-04T19:40:00"), now)).toMatch(/list/);
    expect(slotAllowed(settings, istAt("2026-10-04T22:30:00"), now)).toMatch(/outside/);
    expect(slotAllowed(settings, istAt("2026-10-04T11:30:00"), now)).toMatch(/outside/);
    expect(slotAllowed(settings, istAt("2026-10-04T10:00:00"), now)).toMatch(/15 minutes/);
    expect(slotAllowed(settings, istAt("2026-10-30T19:30:00"), now)).toMatch(/14 days/);
  });
});
