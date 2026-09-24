import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SavrivoOrder} from "../src/types";

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
import {authorizeTransition} from "../src/services/authz";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const database = firestoreDb as unknown as InMemoryFirestore & {collectionsAccessed: string[]};

const uid = "staff-user";
const riderUid = "rider-user";
const restaurantId = "restaurant-a";
const order = {
  id: "order-1",
  customerId: "customer-1",
  restaurantId,
  status: "Order placed",
} as SavrivoOrder;

function token(claims: Record<string, unknown> = {}): DecodedIdToken {
  return {uid, ...claims} as unknown as DecodedIdToken;
}

function tokenFor(nextUid: string, claims: Record<string, unknown> = {}): DecodedIdToken {
  return {uid: nextUid, ...claims} as unknown as DecodedIdToken;
}

describe("restaurant order transition authorization", () => {
  beforeEach(async () => {
    for (const path of database.paths()) await database.doc(path).delete();
    database.collectionsAccessed.length = 0;
  });

  it("fails closed for a legacy staff record missing restaurantId", async () => {
    database.seed(`staff/${uid}`, {active: true, role: "restaurant_manager"});

    await expect(authorizeTransition(uid, token(), order, "Accepted"))
      .rejects.toMatchObject({code: "permission-denied"});
  });

  it("allows legacy staff only for the exact restaurant", async () => {
    database.seed(`staff/${uid}`, {
      active: true,
      restaurantId,
      permissions: {orders: true},
    });

    await expect(authorizeTransition(uid, token(), order, "Accepted")).resolves.toBe("staff");
  });

  it("denies legacy staff assigned to a different restaurant", async () => {
    database.seed(`staff/${uid}`, {
      active: true,
      restaurantId: "restaurant-b",
      role: "restaurant_owner",
    });

    await expect(authorizeTransition(uid, token(), order, "Accepted"))
      .rejects.toMatchObject({code: "permission-denied"});
  });

  it("preserves path-scoped normalized membership compatibility", async () => {
    database.seed(`restaurantMembers/${restaurantId}_${uid}`, {
      active: true,
      role: "restaurant_manager",
    });

    await expect(authorizeTransition(uid, token(), order, "Accepted")).resolves.toBe("staff");
  });

  it.each([
    ["owner", "owner"],
    ["ops_admin", "ops_admin"],
  ] as const)("preserves %s custom-claim access", async (claim, expected) => {
    await expect(authorizeTransition(uid, token({savrivoRole: claim}), order, "Accepted"))
      .resolves.toBe(expected);
    expect(database.collectionsAccessed).toEqual([]);
  });

  it("prefers the rider actor for rider-owned delivery transitions even when the account also has an owner claim", async () => {
    database.seed(`riders/${riderUid}`, {status: "approved"});
    const riderOrder = {
      ...order,
      status: "Handed to rider",
      riderId: riderUid,
    } as SavrivoOrder;

    await expect(authorizeTransition(
      riderUid,
      tokenFor(riderUid, {savrivoRole: "owner"}),
      riderOrder,
      "Out for delivery",
    )).resolves.toBe("rider");
  });
});
