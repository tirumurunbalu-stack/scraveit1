import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  reads: [] as string[],
}));

function nestedValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return null;
  return (value as Record<string, unknown>)[key] ?? null;
}

vi.mock("../src/admin", () => ({
  db: {
    ref: (path: string) => ({
      get: async () => {
        memory.reads.push(path);
        const value = memory.values.get(path) ?? null;
        return {
          exists: () => value !== null,
          val: () => value,
          child: (key: string) => ({val: () => nestedValue(value, key)}),
        };
      },
    }),
  },
  storage: {},
}));

import {ROOT} from "../src/config";
import {
  requireRestaurantMediaAccess,
  type RestaurantMediaUploadInput,
} from "../src/services/mediaUploads";

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
  beforeEach(() => {
    memory.values.clear();
    memory.reads.length = 0;
    memory.values.set(`${ROOT}/catalog/restaurants/${restaurantId}`, {id: restaurantId});
  });

  it("fails closed for a legacy staff record missing restaurantId", async () => {
    memory.values.set(`${ROOT}/staff/${uid}`, {
      active: true,
      permissions: {profile: true},
    });

    await expect(requireRestaurantMediaAccess(uid, token(), input))
      .rejects.toMatchObject({code: "permission-denied"});
  });

  it("allows legacy staff media access only for the exact restaurant", async () => {
    memory.values.set(`${ROOT}/staff/${uid}`, {
      active: true,
      restaurantId,
      permissions: {profile: true},
    });

    await expect(requireRestaurantMediaAccess(uid, token(), input)).resolves.toBeUndefined();
  });

  it("denies media access to legacy staff assigned elsewhere", async () => {
    memory.values.set(`${ROOT}/staff/${uid}`, {
      active: true,
      restaurantId: "restaurant-b",
      role: "restaurant_owner",
    });

    await expect(requireRestaurantMediaAccess(uid, token(), input))
      .rejects.toMatchObject({code: "permission-denied"});
  });

  it("preserves normalized path-scoped owner access", async () => {
    memory.values.set(`${ROOT}/restaurantMembers/${restaurantId}/${uid}`, {
      active: true,
      role: "restaurant_owner",
    });

    await expect(requireRestaurantMediaAccess(uid, token(), input)).resolves.toBeUndefined();
  });

  it.each(["owner", "ops_admin"])("preserves %s custom-claim access", async (claim) => {
    await expect(requireRestaurantMediaAccess(uid, token({savrivoRole: claim}), input)).resolves.toBeUndefined();
    expect(memory.reads).toEqual([`${ROOT}/catalog/restaurants/${restaurantId}`]);
  });
});
