import {describe, expect, it} from "vitest";
import {reduceRestaurantWorkload, trustedActiveOrderCount} from "../src/domain/workload";

describe("backend-owned restaurant workload", () => {
  it("reconciles active counts idempotently and ignores stale order events", () => {
    const placed = {id: "SV-1", restaurantId: "restaurant-1", status: "Order placed" as const, updatedAt: 100};
    const first = reduceRestaurantWorkload(null, placed, 1_000);
    expect(first).toMatchObject({source: "functions", activeOrders: 1, preparing: 0, ready: 0});
    expect(reduceRestaurantWorkload(first, placed, 1_001)).toBe(first);

    const preparing = reduceRestaurantWorkload(first, {...placed, status: "Preparing", updatedAt: 200}, 1_100);
    expect(preparing).toMatchObject({activeOrders: 1, preparing: 1, ready: 0});
    expect(reduceRestaurantWorkload(preparing, {...placed, status: "Accepted", updatedAt: 150}, 1_200)).toBe(preparing);

    const delivered = reduceRestaurantWorkload(preparing, {...placed, status: "Delivered", updatedAt: 300}, 1_300);
    expect(delivered).toMatchObject({activeOrders: 0, preparing: 0, ready: 0});
    expect(delivered.orders["SV-1"]).toMatchObject({status: "Delivered", orderUpdatedAt: 300});
  });

  it("does not trust a client-shaped workload for surge pricing", () => {
    expect(trustedActiveOrderCount({restaurantId: "restaurant-1", activeOrders: 9999}, "restaurant-1")).toBe(0);
    expect(trustedActiveOrderCount({source: "functions", restaurantId: "other", activeOrders: 10}, "restaurant-1")).toBe(0);
    expect(trustedActiveOrderCount({source: "functions", restaurantId: "restaurant-1", activeOrders: 7}, "restaurant-1")).toBe(7);
  });
});
