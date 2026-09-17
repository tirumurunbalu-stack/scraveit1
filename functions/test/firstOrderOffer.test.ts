import {beforeEach, describe, expect, it, vi} from "vitest";

const memory = vi.hoisted(() => ({
  promotions: {} as Record<string, unknown>,
  ordersByCustomer: {} as Record<string, unknown>,
  reads: [] as string[],
}));

vi.mock("../src/admin", () => ({
  db: {
    ref: (path: string) => {
      memory.reads.push(path);
      const chain = {
        orderByChild: () => chain,
        equalTo: () => chain,
        limitToFirst: () => chain,
        get: async () => {
          if (path.endsWith("/promotions")) {
            return {val: () => memory.promotions, exists: () => Object.keys(memory.promotions).length > 0};
          }
          const match = path.match(/\/orders\/([^/]+)$/);
          const value = match ? memory.ordersByCustomer[match[1]] : null;
          return {val: () => value ?? null, exists: () => value != null};
        },
      };
      return chain;
    },
  },
}));

import {calculateDiscount} from "../src/services/catalog";

const OFFER = {
  id: "p1", code: "WELCOME50", title: "Welcome", percent: 50,
  maxDiscount: 100, minimumOrder: 0, active: true, firstOrderOnly: true,
};

describe("first-order-only offers", () => {
  beforeEach(() => {
    memory.promotions = {p1: {...OFFER}};
    memory.ordersByCustomer = {};
    memory.reads.length = 0;
  });

  it("gives the discount to a customer who has never ordered", async () => {
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer")).resolves.toBe(100);
  });

  it("refuses a customer who has ordered before", async () => {
    memory.ordersByCustomer["returning"] = {"SV-1": {status: "Delivered"}};
    await expect(calculateDiscount("WELCOME50", 400, "r1", "returning"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("counts a cancelled order as having ordered, so the offer cannot be farmed", async () => {
    memory.ordersByCustomer["canceller"] = {"SV-1": {status: "Cancelled"}};
    await expect(calculateDiscount("WELCOME50", 400, "r1", "canceller"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("fails closed when the customer cannot be identified", async () => {
    await expect(calculateDiscount("WELCOME50", 400, "r1", ""))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("leaves ordinary offers working for returning customers", async () => {
    memory.promotions = {p1: {...OFFER, firstOrderOnly: false}};
    memory.ordersByCustomer["returning"] = {"SV-1": {status: "Delivered"}};
    await expect(calculateDiscount("WELCOME50", 400, "r1", "returning")).resolves.toBe(100);
  });

  it("does not read order history for an offer that is not first-order-only", async () => {
    memory.promotions = {p1: {...OFFER, firstOrderOnly: false}};
    await calculateDiscount("WELCOME50", 400, "r1", "someone");
    expect(memory.reads.some((path) => path.includes("/orders/"))).toBe(false);
  });

  it("still applies every other rule to a first-order offer", async () => {
    memory.promotions = {p1: {...OFFER, minimumOrder: 500}};
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer"))
      .rejects.toMatchObject({code: "failed-precondition"});

    memory.promotions = {p1: {...OFFER, expiresAt: Date.now() - 1000}};
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer"))
      .rejects.toMatchObject({code: "failed-precondition"});

    memory.promotions = {p1: {...OFFER, restaurantIds: ["r2"]}};
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("caps the discount the same way for a first-order offer", async () => {
    memory.promotions = {p1: {...OFFER, maxDiscount: 60}};
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer")).resolves.toBe(60);
  });
});
