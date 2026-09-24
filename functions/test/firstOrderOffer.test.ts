import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  class TrackedFirestore extends InMemoryFirestore {
    collectionsAccessed: string[] = [];
    collection(name: string) {
      this.collectionsAccessed.push(name);
      return super.collection(name);
    }
  }
  return {firestoreDb: new TrackedFirestore()};
});

import {firestoreDb} from "../src/admin";
import {calculateDiscount} from "../src/services/catalog";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

type TrackedFirestore = InMemoryFirestore & {collectionsAccessed: string[]};

const database = firestoreDb as unknown as TrackedFirestore;

const OFFER = {
  id: "p1", code: "WELCOME50", title: "Welcome", percent: 50,
  maxDiscount: 100, minimumOrder: 0, active: true, firstOrderOnly: true,
};

function seedPromotion(overrides: Record<string, unknown> = {}): void {
  database.seed("promotions/p1", {...OFFER, ...overrides});
}

function seedOrder(orderId: string, customerId: string, status: string): void {
  database.seed(`orders/${orderId}`, {customerId, status});
}

describe("first-order-only offers", () => {
  beforeEach(async () => {
    for (const path of database.paths()) await database.doc(path).delete();
    database.collectionsAccessed.length = 0;
    seedPromotion();
  });

  it("gives the discount to a customer who has never ordered", async () => {
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer")).resolves.toBe(100);
  });

  it("refuses a customer who has ordered before", async () => {
    seedOrder("SV-1", "returning", "Delivered");
    await expect(calculateDiscount("WELCOME50", 400, "r1", "returning"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("counts a cancelled order as having ordered, so the offer cannot be farmed", async () => {
    seedOrder("SV-1", "canceller", "Cancelled");
    await expect(calculateDiscount("WELCOME50", 400, "r1", "canceller"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("fails closed when the customer cannot be identified", async () => {
    await expect(calculateDiscount("WELCOME50", 400, "r1", ""))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("leaves ordinary offers working for returning customers", async () => {
    seedPromotion({firstOrderOnly: false});
    seedOrder("SV-1", "returning", "Delivered");
    await expect(calculateDiscount("WELCOME50", 400, "r1", "returning")).resolves.toBe(100);
  });

  it("does not read order history for an offer that is not first-order-only", async () => {
    seedPromotion({firstOrderOnly: false});
    database.collectionsAccessed.length = 0;
    await calculateDiscount("WELCOME50", 400, "r1", "someone");
    expect(database.collectionsAccessed).not.toContain("orders");
  });

  it("still applies every other rule to a first-order offer", async () => {
    seedPromotion({minimumOrder: 500});
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer"))
      .rejects.toMatchObject({code: "failed-precondition"});

    seedPromotion({expiresAt: Date.now() - 1000});
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer"))
      .rejects.toMatchObject({code: "failed-precondition"});

    seedPromotion({restaurantIds: ["r2"]});
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("caps the discount the same way for a first-order offer", async () => {
    seedPromotion({maxDiscount: 60});
    await expect(calculateDiscount("WELCOME50", 400, "r1", "new-customer")).resolves.toBe(60);
  });
});
