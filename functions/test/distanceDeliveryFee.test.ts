import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore()};
});

import {distanceDeliveryFee} from "../src/services/catalog";

describe("per-km delivery fee", () => {
  const zomatoLike = {deliveryBaseFee: 16, deliveryPerKm: 2};

  it("charges part kilometres pro rata and rounds the total to the rupee", () => {
    expect(distanceDeliveryFee(zomatoLike, 1.7)).toBe(19); // 16 + 3.40
    expect(distanceDeliveryFee(zomatoLike, 0.7)).toBe(17); // 16 + 1.40
    expect(distanceDeliveryFee(zomatoLike, 7)).toBe(30);
    expect(distanceDeliveryFee(zomatoLike, 0)).toBe(16);
  });

  it("falls back to the slabs when per-km pricing is not set", () => {
    expect(distanceDeliveryFee({}, 3)).toBeNull();
    expect(distanceDeliveryFee({deliveryBaseFee: 16}, 3)).toBeNull();
    expect(distanceDeliveryFee({deliveryBaseFee: 0, deliveryPerKm: 0}, 3)).toBeNull();
    expect(distanceDeliveryFee({deliveryBaseFee: -1, deliveryPerKm: 2}, 3)).toBeNull();
  });
});
