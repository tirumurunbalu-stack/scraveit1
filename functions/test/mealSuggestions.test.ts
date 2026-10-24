import {beforeEach, describe, expect, it, vi} from "vitest";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const db = new InMemoryFirestore();
const sent: Array<{uid: string; key: string; title: string; body: string}> = [];
vi.mock("../src/admin", () => ({firestoreDb: db, auth: {}, storage: {}, messaging: {}, db: {}}));
vi.mock("../src/services/notifications", () => ({notifyMealSuggestion: async (m: never) => { sent.push(m); }}));

const {mealSuggestionFor, runMealSuggestions} = await import("../src/services/mealSuggestions");

const HOUR = 3_600_000;
const LUNCH = Date.UTC(2026, 9, 23, 7, 0); // 12:30 pm in India
const home = {addresses: [{id: "a", city: "Naidupeta"}], selectedAddressId: "a"};
const waffle = {id: "waffle", name: "The Waffle Spot", city: "naidupeta", kind: "restaurant" as const};
const dairy = {id: "oxy", name: "Oxy", city: "naidupeta", kind: "dairy" as const};

describe("what a meal-time suggestion says", () => {
  it("names a favourite store that is open", () => {
    expect(mealSuggestionFor("lunch", {...home, favourites: ["waffle"]}, [waffle], 0))
      .toEqual({title: "🍛 Lunch from The Waffle Spot?", body: "The Waffle Spot is open now. Order your usual in a tap 🤤"});
  });
  it("otherwise a meal idea that changes day to day", () => {
    const a = mealSuggestionFor("dinner", home, [waffle], 0), b = mealSuggestionFor("dinner", home, [waffle], 1);
    expect(a?.title).toBe("🌙 Dinner sorted?");
    expect(b?.title).not.toBe(a?.title);
  });
  it("only stores in the customer's town; nothing when none is open there", () => {
    expect(mealSuggestionFor("lunch", home, [{...waffle, city: "nellore"}], 0)).toBeNull();
    expect(mealSuggestionFor("lunch", home, [dairy], 0)).toBeNull();
    expect(mealSuggestionFor("breakfast", home, [dairy], 0)?.title).toBe("🥛 Fresh milk for the morning?");
  });
});

describe("sending meal-time suggestions", () => {
  beforeEach(() => {
    for (const path of db.paths()) db.read(path) && void db.recursiveDelete(db.doc(path));
    sent.length = 0;
    db.seed("restaurants/waffle", {name: "The Waffle Spot", city: "Naidupeta", open: true});
    db.seed("restaurants/shut", {name: "Shut Kitchen", city: "Naidupeta", open: false});
    for (const uid of ["u1", "off", "kid", "fed", "carted"]) db.seed(`users/${uid}`, {...home});
    db.seed("users/off", {...home, preferences: {mealSuggestions: false}});
    db.seed("accountAges/kid", {minor: true});
    db.seed("orders/o1", {customerId: "fed", createdAt: LUNCH - HOUR});
    db.seed("users/carted", {...home, cartReminder: {lastAt: LUNCH - HOUR}});
  });

  it("sends one per person, skipping those who said no, children, and people who just ordered", async () => {
    expect(await runMealSuggestions("lunch", LUNCH)).toBe(1);
    expect(sent.map((m) => m.uid)).toEqual(["u1"]);
    expect(sent[0]?.key).toBe("meal:2026-10-23:lunch:u1");
  });

  it("sends nothing when every store is closed", async () => {
    db.seed("restaurants/waffle", {name: "The Waffle Spot", city: "Naidupeta", open: false});
    expect(await runMealSuggestions("dinner", LUNCH)).toBe(0);
  });
});
