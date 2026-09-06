import {describe, expect, it} from "vitest";
import {
  buildRestaurantOrderProjection,
  shouldApplyRestaurantOrderProjection,
} from "../src/domain/restaurantOrder";
import type {SavrivoOrder} from "../src/types";

describe("restaurant order privacy projection", () => {
  it("keeps order operations but removes raw phone and exact drop location", () => {
    const order = {
      id: "SV-RESTAURANT",
      customerId: "customer-1",
      customerName: "Customer",
      customerPhone: "+919999999999",
      contactProxy: "+911234567890",
      address: {
        id: "home",
        label: "Home",
        area: "Naidupeta",
        city: "Tirupati",
        address: "Exact house and street",
        phone: "+918888888888",
        lat: 13.91,
        lng: 79.89,
      },
      status: "Preparing",
      deliveryOtpHash: "a".repeat(64),
      deliveryOtpSalt: "b".repeat(32),
    } as unknown as SavrivoOrder;

    const projection = buildRestaurantOrderProjection(order);
    expect(projection).toMatchObject({
      id: "SV-RESTAURANT",
      customerId: "customer-1",
      status: "Preparing",
      contactProxy: "+911234567890",
      address: {label: "Home", area: "Naidupeta", city: "Tirupati"},
    });
    expect(projection).not.toHaveProperty("customerPhone");
    expect(projection.address).not.toHaveProperty("address");
    expect(projection.address).not.toHaveProperty("phone");
    expect(projection.address).not.toHaveProperty("lat");
    expect(projection.address).not.toHaveProperty("lng");
    expect(JSON.stringify(projection)).not.toContain("9999999999");
    expect(JSON.stringify(projection)).not.toContain("8888888888");
    expect(JSON.stringify(projection)).not.toContain("deliveryOtp");
  });
});

describe("restaurant order projection ordering", () => {
  function projection(status: SavrivoOrder["status"], updatedAt: number) {
    return buildRestaurantOrderProjection({
      id: "SV-RACE",
      customerId: "customer-1",
      restaurantId: "restaurant-1",
      address: {label: "Home", area: "Naidupeta"},
      status,
      updatedAt,
    } as SavrivoOrder);
  }

  it("accepts a newer canonical status and rejects an older pending retry", () => {
    const accepted = projection("Accepted", 200);
    expect(shouldApplyRestaurantOrderProjection(projection("Order placed", 100), accepted)).toBe(true);
    expect(shouldApplyRestaurantOrderProjection(accepted, projection("Order placed", 100))).toBe(false);
  });

  it("does not let equal-time events move an order backwards", () => {
    const preparing = projection("Preparing", 300);
    expect(shouldApplyRestaurantOrderProjection(preparing, projection("Accepted", 300))).toBe(false);
    expect(shouldApplyRestaurantOrderProjection(projection("Accepted", 300), preparing)).toBe(true);
  });

  it("allows an idempotent projection refresh but rejects a different order identity", () => {
    const accepted = projection("Accepted", 200);
    expect(shouldApplyRestaurantOrderProjection(accepted, {...accepted})).toBe(true);
    expect(shouldApplyRestaurantOrderProjection(accepted, {...accepted, id: "SV-OTHER"})).toBe(false);
  });
});
