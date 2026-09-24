import type {DecodedIdToken} from "firebase-admin/auth";
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
  return {firestoreDb: new TrackedFirestore(), storage: {}};
});

import {firestoreDb} from "../src/admin";
import {
  requireRestaurantMediaAccess,
  type RestaurantMediaUploadInput,
} from "../src/services/mediaUploads";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

type TrackedFirestore = InMemoryFirestore & {collectionsAccessed: string[]};

const database = firestoreDb as unknown as TrackedFirestore;

const uid = "staff-user";
const restaurantId = "restaurant-a";
const input: RestaurantMediaUploadInput = {
  restaurantId,
  kind: "cover",
  contentType: "image/jpeg",
  dataBase64: "AAAA",
};

function token(claims: Record<string, unknown> = {}): DecodedIdToken {
  return {uid, ...claims} as unknown as DecodedIdToken;
}

describe("restaurant media authorization", () => {
  beforeEach(async () => {
    for (const path of database.paths()) await database.doc(path).delete();
    database.collectionsAccessed.length = 0;
    database.seed(`restaurants/${restaurantId}`, {id: restaurantId});
  });

  it("fails closed for a legacy staff record missing restaurantId", async () => {
    database.seed(`staff/${uid}`, {
      active: true,
      permissions: {profile: true},
    });

    await expect(requireRestaurantMediaAccess(uid, token(), input))
      .rejects.toMatchObject({code: "permission-denied"});
  });

  it("allows legacy staff media access only for the exact restaurant", async () => {
    database.seed(`staff/${uid}`, {
      active: true,
      restaurantId,
      permissions: {profile: true},
    });

    await expect(requireRestaurantMediaAccess(uid, token(), input)).resolves.toBeUndefined();
  });

  it("denies media access to legacy staff assigned elsewhere", async () => {
    database.seed(`staff/${uid}`, {
      active: true,
      restaurantId: "restaurant-b",
      role: "restaurant_owner",
    });

    await expect(requireRestaurantMediaAccess(uid, token(), input))
      .rejects.toMatchObject({code: "permission-denied"});
  });

  it("preserves normalized path-scoped owner access", async () => {
    database.seed(`restaurantMembers/${restaurantId}_${uid}`, {
      active: true,
      role: "restaurant_owner",
    });

    await expect(requireRestaurantMediaAccess(uid, token(), input)).resolves.toBeUndefined();
  });

  it.each(["owner", "ops_admin"])("preserves %s custom-claim access", async (claim) => {
    await expect(requireRestaurantMediaAccess(uid, token({savrivoRole: claim}), input)).resolves.toBeUndefined();
    expect(database.collectionsAccessed).toEqual(["restaurants"]);
  });
});
