import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}, messaging: {}, db: {}}));
vi.mock("../src/services/notifications", () => ({notifyCartReminder: vi.fn()}));

const {cartReminderCopy, reminderDue, istHour, FOLLOW_UP_AFTER} = await import("../src/services/cartReminders");

const MIN = 60_000, HOUR = 60 * MIN;
// 23 Oct 2026, 1:30 pm in India.
const LUNCH = Date.UTC(2026, 9, 23, 8, 0);
const cart = {restaurantId: "r1", restaurantName: "Waffle Spot", storeType: "restaurant", itemCount: 3, firstItem: "Nutella waffle", subtotal: 420, updatedAt: LUNCH - FOLLOW_UP_AFTER};

describe("cart follow-up words", () => {
  it("names the item and store, and speaks dairy and grocery differently", () => {
    expect(istHour(LUNCH)).toBe(13);
    expect(cartReminderCopy(cart)).toEqual({title: "👀 Still thinking about Nutella waffle?", body: "Your cart at Waffle Spot is saved. Order it before you get hangry 😋"});
    expect(cartReminderCopy({...cart, storeType: "dairy", itemCount: 1, firstItem: "Toned milk"}))
      .toEqual({title: "🥛 Still need your dairy?", body: "Toned milk from Waffle Spot is saved in your cart. Fresh delivery is a tap away 🐄"});
    expect(cartReminderCopy({...cart, storeType: "grocery"}).title).toBe("🧺 Your basket is still here");
  });
});

describe("when the follow-up is due", () => {
  it("about 20 hours after the cart last changed, not sooner (the phone sends the first one)", () => {
    expect(reminderDue(cart, null, [], LUNCH)).toBe(true);
    expect(reminderDue({...cart, updatedAt: LUNCH - 45 * MIN}, null, [], LUNCH)).toBe(false);
  });
  it("only once for a cart, and a changed cart starts over", () => {
    expect(reminderDue(cart, {for: cart.updatedAt, count: 1, lastAt: LUNCH - HOUR}, [], LUNCH)).toBe(false);
    expect(reminderDue(cart, {for: cart.updatedAt - 5 * HOUR, count: 1, lastAt: LUNCH - 25 * HOUR}, [], LUNCH)).toBe(true);
  });
  it("never at night, never after a day, never more than three a week", () => {
    const night = Date.UTC(2026, 9, 23, 17, 0); // 10:30 pm
    expect(reminderDue({...cart, updatedAt: night - 21 * HOUR}, null, [], night)).toBe(false);
    expect(reminderDue({...cart, updatedAt: LUNCH - 27 * HOUR}, null, [], LUNCH)).toBe(false);
    expect(reminderDue(cart, null, [LUNCH - HOUR, LUNCH - 2 * HOUR, LUNCH - 3 * HOUR], LUNCH)).toBe(false);
    expect(reminderDue(cart, null, [LUNCH - 8 * 24 * HOUR], LUNCH)).toBe(true);
  });
  it("needs a real cart", () => {
    expect(reminderDue(null, null, [], LUNCH)).toBe(false);
    expect(reminderDue({...cart, itemCount: 0}, null, [], LUNCH)).toBe(false);
  });
});
