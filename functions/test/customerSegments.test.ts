import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore()};
});

import {firestoreDb} from "../src/admin";
import {
  ageBandFor,
  ageOn,
  areaKey,
  audienceMismatch,
  normalizeAudience,
  segmentFrom,
} from "../src/domain/customerSegments";
import {normalizePromotionTerms} from "../src/domain/economics";
import {buildAnalytics, analyticsOrderFrom} from "../src/services/adminAnalytics";
import {resolveCheckoutPromotion} from "../src/services/economics";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const database = firestoreDb as unknown as InMemoryFirestore;
// 6 Oct 2026, midday in India.
const NOW = Date.UTC(2026, 9, 6, 6, 30);

describe("age and segments", () => {
  it("counts age in whole years on the Indian date", () => {
    expect(ageOn("2000-10-06", NOW)).toBe(26);
    expect(ageOn("2000-10-07", NOW)).toBe(25);
    expect(ageOn("2000-02-30", NOW)).toBeNull();
    expect(ageOn("not a date", NOW)).toBeNull();
  });

  it("puts adults in age groups and never anyone under 18", () => {
    expect(ageBandFor("2008-10-06", NOW)).toBe("18-24");
    expect(ageBandFor("2008-10-07", NOW)).toBe("");
    expect(ageBandFor("1992-01-01", NOW)).toBe("25-34");
    expect(ageBandFor("1960-01-01", NOW)).toBe("55+");
  });

  it("uses details only with consent, and drops a child's record entirely", () => {
    expect(segmentFrom({gender: "female", birthDate: "1995-05-05", consent: true}, NOW))
      .toEqual({gender: "female", ageBand: "25-34"});
    expect(segmentFrom({gender: "female", birthDate: "1995-05-05", consent: false}, NOW))
      .toEqual({gender: "", ageBand: ""});
    expect(segmentFrom({gender: "male", birthDate: "2012-01-01", consent: true}, NOW))
      .toEqual({gender: "", ageBand: ""});
    expect(segmentFrom({gender: "male", consent: true}, NOW)).toEqual({gender: "male", ageBand: ""});
  });

  it("treats differently written area names as one area", () => {
    expect(areaKey("Magunta Layout")).toBe(areaKey(" magunta  layout,"));
  });

  it("matches offers to the right group only", () => {
    const women2534 = normalizeAudience({genders: ["female"], ageBands: ["25-34"]});
    expect(audienceMismatch(women2534, {gender: "female", ageBand: "25-34"}, "")).toBeNull();
    expect(audienceMismatch(women2534, {gender: "male", ageBand: "25-34"}, "")).toBe("not_for_you");
    expect(audienceMismatch(women2534, {gender: "female", ageBand: "35-44"}, "")).toBe("not_for_you");
    expect(audienceMismatch(women2534, {gender: "", ageBand: ""}, "")).toBe("not_for_you");
    const area = normalizeAudience({areaKeys: ["Magunta Layout"]});
    expect(audienceMismatch(area, {gender: "", ageBand: ""}, "magunta layout")).toBeNull();
    expect(audienceMismatch(area, {gender: "", ageBand: ""}, "Balaji Nagar")).toBe("wrong_area");
  });

  it("reads older offers without targeting as offers for everyone", () => {
    const terms = normalizePromotionTerms("p", {code: "X", active: true, percent: 10});
    expect(terms.audience).toEqual({genders: [], ageBands: [], areaKeys: []});
    expect(terms.itemIds).toEqual([]);
  });
});

describe("targeted offers at checkout", () => {
  const base = {subtotalPaise: 40_000, restaurantId: "r1", cityKey: "nellore", at: NOW};
  beforeEach(async () => {
    for (const path of database.paths()) await database.doc(path).delete();
  });

  it("gives a women 25-34 offer to a matching customer and refuses others", async () => {
    database.seed("promotions/p1", {code: "SHE25", title: "For you", active: true, kind: "percent", percent: 20,
      audience: {genders: ["female"], ageBands: ["25-34"], areaKeys: []}});
    database.seed("customerDemographics/u1", {gender: "female", birthDate: "1996-03-03", consent: true});
    database.seed("customerDemographics/u2", {gender: "male", birthDate: "1996-03-03", consent: true});
    await expect(resolveCheckoutPromotion("SHE25", {...base, customerId: "u1"})).resolves.toMatchObject({terms: {code: "SHE25"}});
    await expect(resolveCheckoutPromotion("SHE25", {...base, customerId: "u2"}))
      .rejects.toMatchObject({message: "This offer is for a different group of customers."});
    await expect(resolveCheckoutPromotion("SHE25", {...base, customerId: "nobody"}))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("checks the delivery area for area offers", async () => {
    database.seed("promotions/p1", {code: "MAGUNTA", title: "Area", active: true, kind: "flat", flatAmountPaise: 5000,
      audience: {genders: [], ageBands: [], areaKeys: ["magunta-layout"]}});
    await expect(resolveCheckoutPromotion("MAGUNTA", {...base, customerId: "u1", deliveryArea: "Magunta Layout"}))
      .resolves.not.toBeNull();
    await expect(resolveCheckoutPromotion("MAGUNTA", {...base, customerId: "u1", deliveryArea: "Stonehousepet"}))
      .rejects.toMatchObject({message: "This offer isn't available at this delivery address."});
  });

  it("works a dish offer out on that dish only, and needs the dish in the cart", async () => {
    database.seed("promotions/p1", {code: "WAFFLE", title: "Waffle", active: true, kind: "percent", percent: 50,
      restaurantIds: ["r1"], itemIds: ["w1"], itemNames: ["Nutella waffle"]});
    const withDish = await resolveCheckoutPromotion("WAFFLE", {...base, customerId: "u1",
      lines: [{itemId: "w1", lineTotalPaise: 18_000}, {itemId: "c1", lineTotalPaise: 22_000}]});
    expect(withDish?.discountBasePaise).toBe(18_000);
    await expect(resolveCheckoutPromotion("WAFFLE", {...base, customerId: "u1",
      lines: [{itemId: "c1", lineTotalPaise: 22_000}]}))
      .rejects.toMatchObject({message: "Add one of the dishes in this offer to use it."});
  });
});

describe("analytics", () => {
  const day = 24 * 60 * 60 * 1000;
  const order = (id: string, customerId: string, extra: Record<string, unknown> = {}) => analyticsOrderFrom(id, {
    customerId, restaurantId: "r1", restaurant: "Waffle Spot", status: "Delivered",
    createdAt: NOW - 2 * day, deliveredAt: NOW - 2 * day + 30 * 60_000,
    pricing: {subtotal: 300, discount: 0}, paymentMethod: "upi",
    address: {area: "Magunta Layout", lat: 14.44, lng: 79.98},
    items: [{itemId: "w1", name: "Nutella waffle", quantity: 1, price: 180, diet: "veg"},
      {itemId: "s1", name: "Cold coffee", quantity: 1, price: 120, diet: "veg"}],
    ...extra,
  });
  const segments = new Map([
    ["a", {gender: "female" as const, ageBand: "18-24" as const}],
    ["b", {gender: "female" as const, ageBand: "18-24" as const}],
    ["c", {gender: "male" as const, ageBand: "35-44" as const}],
  ]);
  const build = (orders: ReturnType<typeof order>[]) => buildAnalytics({
    orders, segments, periodStart: NOW - 30 * day, now: NOW, days: 30, kind: "all",
    kindOf: () => "restaurant", restaurantName: () => "Waffle Spot",
  });

  it("splits orders by gender and age, with 'Not shared' for the rest", () => {
    const result = build([order("1", "a"), order("2", "b"), order("3", "c"), order("4", "d")]);
    const women = result.genders.find((g) => g.key === "female")!;
    expect(women.orders).toBe(2);
    expect(women.sharePct).toBe(50);
    expect(result.genders.find((g) => g.key === "unknown")?.orders).toBe(1);
    expect(result.ageBands.find((a) => a.key === "18-24")?.orders).toBe(2);
    expect(result.coverage).toMatchObject({customers: 4, withGender: 3, genderPct: 75});
  });

  it("ranks dishes, restaurants and areas, and finds what goes together", () => {
    const result = build([order("1", "a"), order("2", "b"), order("3", "c")]);
    expect(result.items[0]).toMatchObject({name: "Nutella waffle", quantity: 3, customers: 3});
    expect(result.restaurants[0]).toMatchObject({name: "Waffle Spot", orders: 3, delivered: 3});
    expect(result.areas[0]).toMatchObject({name: "Magunta Layout", orders: 3, avgDeliveryMinutes: 30});
    expect(result.pairs[0]).toMatchObject({a: "Cold coffee", b: "Nutella waffle", orders: 3});
    expect(result.summary).toMatchObject({orders: 3, delivered: 3, gmvPaise: 90_000, aovPaise: 30_000});
  });

  it("gives each group its own top dishes, with a lift against everyone", () => {
    const result = build([
      order("1", "a", {items: [{itemId: "w1", name: "Nutella waffle", quantity: 2, price: 180}]}),
      order("2", "b", {items: [{itemId: "w1", name: "Nutella waffle", quantity: 1, price: 180}]}),
      order("3", "c", {items: [{itemId: "s1", name: "Cold coffee", quantity: 3, price: 120}]}),
    ]);
    const women = result.groupPicks.find((g) => g.gender === "female" && g.ageBand === "")!;
    expect(women.items[0]).toMatchObject({name: "Nutella waffle", quantity: 3});
    expect(women.items[0]!.lift).toBe(2);
  });

  it("counts cancellations separately and keeps them out of sales", () => {
    const result = build([order("1", "a"), order("2", "b", {status: "Cancelled", cancelReason: "Restaurant busy",
      cancelledByRole: "restaurant"})]);
    expect(result.summary).toMatchObject({orders: 2, placed: 1, cancelled: 1, cancelRatePct: 50, gmvPaise: 30_000});
    expect(result.cancellations[0]).toMatchObject({by: "restaurant", reason: "Restaurant busy", orders: 1});
  });

  it("tells new customers from returning ones", () => {
    const result = build([order("0", "a", {createdAt: NOW - 50 * day}), order("1", "a"), order("2", "b")]);
    expect(result.summary).toMatchObject({customers: 2, newCustomers: 1, returningCustomers: 1});
  });
});
