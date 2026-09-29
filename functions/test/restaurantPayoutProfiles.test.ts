import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {
  mergePayoutProfile,
  movePayoutProfileToPrivate,
  withPrivatePayoutProfiles,
} from "../src/services/restaurantPayoutProfiles";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const DELETE = Symbol("delete");

describe("restaurant payout profiles are private", () => {
  it("prefers the private record, falling back to a not-yet-moved listing copy", () => {
    expect(mergePayoutProfile({name: "A", payoutProfile: {upiId: "old@x", updatedAt: 1}}, {upiId: "new@x", updatedAt: 2}))
      .toMatchObject({payoutProfile: {upiId: "new@x"}});
    expect(mergePayoutProfile({name: "A", payoutProfile: {upiId: "old@x", updatedAt: 1}}, null))
      .toMatchObject({payoutProfile: {upiId: "old@x"}});
    expect(mergePayoutProfile({name: "A"}, null)).toEqual({name: "A"});
  });

  it("moves bank details off the public listing into the private record", async () => {
    const database = new InMemoryFirestore();
    database.seed("restaurants/r1", {name: "A", payoutProfile: {bankAccountNumber: "123", updatedAt: 5}});
    await movePayoutProfileToPrivate(database, "r1", {bankAccountNumber: "123", updatedAt: 5}, DELETE);
    expect(database.read("restaurantPayoutProfiles/r1")).toMatchObject({bankAccountNumber: "123", restaurantId: "r1"});
    const merged = await withPrivatePayoutProfiles(database, {r1: {name: "A"}});
    expect(merged.r1).toMatchObject({payoutProfile: {bankAccountNumber: "123"}});
  });

  it("never overwrites a newer private record with an older listing copy", async () => {
    const database = new InMemoryFirestore();
    database.seed("restaurants/r1", {name: "A", payoutProfile: {bankAccountNumber: "old", updatedAt: 1}});
    database.seed("restaurantPayoutProfiles/r1", {bankAccountNumber: "new", updatedAt: 9});
    await movePayoutProfileToPrivate(database, "r1", {bankAccountNumber: "old", updatedAt: 1}, DELETE);
    expect(database.read("restaurantPayoutProfiles/r1")).toMatchObject({bankAccountNumber: "new"});
  });
});
