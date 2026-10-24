import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}, messaging: {}}));

const {istDay, nextStreak, streakLevel, streakMilestone, isCraveMatch, sharesEating, eatingCard} = await import("../src/services/chatFun");

const members = ["a", "b"];

describe("food streaks", () => {
  it("uses the India calendar day", () => {
    expect(istDay(Date.parse("2026-10-09T19:00:00Z"))).toBe("2026-10-10");
    expect(istDay(Date.parse("2026-10-09T17:00:00Z"))).toBe("2026-10-09");
  });
  it("starts when both friends message on the same day and grows day after day", () => {
    let s = nextStreak(null, "a", members, "2026-10-05");
    expect(s.count).toBe(0);
    s = nextStreak(s, "b", members, "2026-10-05");
    expect(s.count).toBe(1);
    s = nextStreak(s, "a", members, "2026-10-05");
    expect(s.count).toBe(1);
    s = nextStreak(nextStreak(s, "a", members, "2026-10-06"), "b", members, "2026-10-06");
    expect(s.count).toBe(2);
  });
  it("forgives one missed day a week, then restarts", () => {
    let s = {count: 5, lastDay: "2026-10-05", by: {a: "2026-10-05", b: "2026-10-05"}};
    s = nextStreak(nextStreak(s, "a", members, "2026-10-07"), "b", members, "2026-10-07");
    expect(s.count).toBe(6);
    s = nextStreak(nextStreak(s, "a", members, "2026-10-09"), "b", members, "2026-10-09");
    expect(s.count).toBe(1);
  });
  it("levels up the dish and celebrates milestones only", () => {
    expect(streakLevel(1).emoji).toBe("🍞");
    expect(streakLevel(7).emoji).toBe("🍕");
    expect(streakLevel(120).name).toBe("Royal thali");
    expect(streakMilestone({count: 6, lastDay: "", by: {}}, {count: 7, lastDay: "", by: {}})).toBe(7);
    expect(streakMilestone({count: 7, lastDay: "", by: {}}, {count: 7, lastDay: "", by: {}})).toBe(0);
    expect(streakMilestone({count: 4, lastDay: "", by: {}}, {count: 5, lastDay: "", by: {}})).toBe(0);
  });
});

describe("craving match", () => {
  it("matches the same dish within 30 minutes", () => {
    const now = 10_000_000;
    expect(isCraveMatch({dish: "pizza", at: now}, {dish: "pizza", at: now - 20 * 60_000}, now)).toBe(true);
    expect(isCraveMatch({dish: "pizza", at: now}, {dish: "pizza", at: now - 40 * 60_000}, now)).toBe(false);
    expect(isCraveMatch({dish: "pizza", at: now}, {dish: "biryani", at: now}, now)).toBe(false);
    expect(isCraveMatch({dish: "pizza", at: now}, undefined, now)).toBe(false);
  });
});

describe("eating now", () => {
  it("is on for adults, off for under-18s unless they turn it on", () => {
    expect(sharesEating({status: "active", minor: false})).toBe(true);
    expect(sharesEating({status: "active", minor: true})).toBe(false);
    expect(sharesEating({status: "active", minor: true, shareEating: true})).toBe(true);
    expect(sharesEating({status: "active", shareEating: false})).toBe(false);
    expect(sharesEating({status: "suspended"})).toBe(false);
  });
  it("shares the dish and restaurant, never the address", () => {
    const card = eatingCard({items: [{name: "Chicken 65", itemId: "c65"}, {name: "Naan"}], restaurant: "Spice Hub", restaurantId: "r1", address: {address: "home"}} as never, 1000);
    expect(card).toMatchObject({dish: "Chicken 65", more: 1, restaurantName: "Spice Hub", until: 1000 + 30 * 60_000});
    expect(JSON.stringify(card)).not.toMatch(/home/);
  });
});

describe("taste match and IOUs", async () => {
  const {tasteMatch, iouText} = await import("../src/services/chatFun");
  const o = (restaurantId: string, ...names: string[]) => ({restaurantId, status: "Delivered", items: names.map((name) => ({name, quantity: 1}))});
  it("gives friends who order the same things a high match and a title", () => {
    const m = tasteMatch([o("r1", "Chicken Dum Biryani"), o("r1", "Chicken 65")], [o("r1", "Chicken Dum Biryani"), o("r2", "Mutton Biryani")]);
    expect(m.percent).toBeGreaterThan(60);
    expect(m.title).toBe("Biryani twins");
    expect(m.shared).toEqual(["chicken dum biryani"]);
  });
  it("still gives a playful result when tastes differ", () => {
    const m = tasteMatch([o("r1", "Belgian Waffle")], [o("r2", "Paneer Butter Masala")]);
    expect(m.percent).toBe(25);
    expect(m.title).toBe("Opposites attract");
    expect(m.shared).toEqual([]);
  });
  it("words an IOU naturally", () => {
    expect(iouText("Balaji", "Balu", "icecream", "the cricket bet")).toBe("🧾 Balaji owes Balu an ice cream 🍦 for the cricket bet");
    expect(iouText("Balu", "Balaji", "waffles", "")).toBe("🧾 Balu owes Balaji a waffle 🧇");
  });
});
