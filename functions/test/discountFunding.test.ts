import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }}}));

import {orderDeliveryAmounts} from "../src/services/ledger";
import type {SavrivoOrder} from "../src/types";

/**
 * Who actually pays for a promotion.
 *
 * This is a business-critical property, not an implementation detail, so it is
 * pinned here: the ledger allocates a delivered order from the DISCOUNTED menu
 * consideration, which means a coupon is funded out of the restaurant's
 * payable, not out of platform revenue. The platform only ever gives up its
 * commission share of the discount.
 *
 * Two consequences worth keeping true on purpose:
 *  - the platform cannot take a loss on a discount, and
 *  - every discount spends the restaurant's money, so offers need explicit
 *    restaurant consent rather than being applied platform-wide by default.
 */
const COMMISSION_BPS = 1_500; // 15%

function order(subtotal: number, discount: number): Pick<SavrivoOrder, "total" | "pricing"> {
  const deliveryFee = 19, platformFee = 15, tax = 0, tip = 0;
  const total = subtotal - discount + deliveryFee + platformFee + tax + tip;
  return {
    total,
    pricing: {
      subtotal, discount, deliveryFee, platformFee, tax, tip,
      smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0, riderIncentiveFee: 0,
      currency: "INR", source: "server",
    },
  } as unknown as Pick<SavrivoOrder, "total" | "pricing">;
}

const platformRevenue = (a: {platformCommissionPaise: number; platformFeePaise: number}) =>
  a.platformCommissionPaise + a.platformFeePaise;

describe("who funds a promotion", () => {
  it("takes the discount out of the restaurant's payable, not the platform's revenue", () => {
    const full = orderDeliveryAmounts(order(200, 0), COMMISSION_BPS);
    const halfOff = orderDeliveryAmounts(order(200, 100), COMMISSION_BPS);

    // The restaurant absorbs the discount less its commission share.
    expect(full.restaurantPayablePaise).toBe(17_000);
    expect(halfOff.restaurantPayablePaise).toBe(8_500);
    expect(full.restaurantPayablePaise - halfOff.restaurantPayablePaise).toBe(8_500);

    // The platform gives up only commission on the discounted amount.
    expect(platformRevenue(full)).toBe(4_500);
    expect(platformRevenue(halfOff)).toBe(3_000);
    expect(platformRevenue(full) - platformRevenue(halfOff)).toBe(1_500);
  });

  it("never lets a discount push platform revenue below zero, at any depth", () => {
    [0, 25, 50, 75, 90, 99, 100].forEach((percent) => {
      const subtotal = 200, discount = (subtotal * percent) / 100;
      const amounts = orderDeliveryAmounts(order(subtotal, discount), COMMISSION_BPS);
      expect(platformRevenue(amounts), `${percent}% off`).toBeGreaterThanOrEqual(0);
      expect(amounts.restaurantPayablePaise, `${percent}% off`).toBeGreaterThanOrEqual(0);
    });
  });

  it("keeps platform fees whole even at a 100% discount", () => {
    const free = orderDeliveryAmounts(order(200, 200), COMMISSION_BPS);
    expect(free.restaurantPayablePaise).toBe(0);
    expect(free.platformCommissionPaise).toBe(0);
    // The customer still paid delivery and platform fees, so the platform is
    // not out of pocket even when the food itself is free.
    expect(free.platformFeePaise).toBe(1_500);
    expect(free.riderDeliveryEarningPaise).toBe(1_900);
  });

  it("still pays the rider in full out of the delivery fee when an order is discounted", () => {
    const discounted = orderDeliveryAmounts(order(200, 100), COMMISSION_BPS);
    expect(discounted.riderDeliveryEarningPaise).toBe(1_900);
  });
});
