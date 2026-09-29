import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {recordRiderDeliveredOrder, riderPublicStats} from "../src/services/riderDeliveryCount";
import type {SavrivoOrder} from "../src/types";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const delivered = (id: string) => ({id, riderId: "r1", status: "Delivered"}) as unknown as SavrivoOrder;

describe("rider delivered-order count", () => {
  it("fills the count from past deliveries once, then counts each new order exactly once", async () => {
    const database = new InMemoryFirestore();
    database.seed("riders/r1", {status: "approved"});
    for (const id of ["a", "b", "c"]) database.seed(`orders/${id}`, {riderId: "r1", status: "Delivered"});
    database.seed("orders/x", {riderId: "r1", status: "Cancelled"});
    await recordRiderDeliveredOrder(delivered("c"), database);
    expect(database.read("riders/r1")).toMatchObject({deliveredOrderCount: 3});
    database.seed("orders/d", {riderId: "r1", status: "Delivered"});
    await recordRiderDeliveredOrder(delivered("d"), database);
    await recordRiderDeliveredOrder(delivered("d"), database);
    await recordRiderDeliveredOrder(delivered("a"), database);
    expect(database.read("riders/r1")).toMatchObject({deliveredOrderCount: 4});
  });

  it("shares only a real rating and the delivery count", () => {
    expect(riderPublicStats({rating: 4.87, ratingCount: 12, deliveredOrderCount: 979, phone: "999"}))
      .toEqual({riderRating: 4.9, riderDeliveredCount: 979});
    expect(riderPublicStats({rating: 5, ratingCount: 0})).toEqual({});
  });
});
