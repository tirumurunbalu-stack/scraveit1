import {describe, expect, it} from "vitest";
import {clusterBill, clusterIdFor, clusterPartKey, partTemperature} from "../src/services/clusterOrders";
import type {SavrivoOrder} from "../src/types";

describe("cluster orders", () => {
  it("knows which bags must travel cold", () => {
    expect(partTemperature(["Chicken biryani", "Butterscotch Ice Cream"])).toBe("frozen");
    expect(partTemperature(["Veg meals", "Sweet lassi"])).toBe("cold");
    expect(partTemperature(["Chicken biryani"])).toBe("hot");
  });

  it("gives every part a stable, valid key of its own", () => {
    const key = "k".repeat(80);
    const a = clusterPartKey(key, 0), b = clusterPartKey(key, 1);
    expect(a).not.toBe(b);
    expect(a).toBe(clusterPartKey(key, 0));
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    expect(clusterIdFor("uid1", key)).toBe(clusterIdFor("uid1", key));
    expect(clusterIdFor("uid1", key)).not.toBe(clusterIdFor("uid2", key));
  });

  it("adds up one bill from each restaurant's part", () => {
    const order = (id: string, restaurant: string, subtotal: number, total: number) => ({
      id, restaurant, total,
      pricing: {subtotal, tax: 5, deliveryFee: 30, platformFee: id === "a" ? 7 : 0, smallOrderFee: 0},
    }) as unknown as SavrivoOrder;
    const bill = clusterBill([order("a", "Biryani House", 250, 292.1), order("b", "Ice Cream Hub", 80, 115.05)]);
    expect(bill.parts).toHaveLength(2);
    expect(bill.parts[1]?.platformFee).toBe(0);
    expect(bill.total).toBe(407.15);
  });
});
