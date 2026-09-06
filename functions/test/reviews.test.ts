import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }}}));

import {ROOT} from "../src/config";
import {
  containsUnverifiedReviewMoney,
  recordDeliveredReviewFeedback,
} from "../src/services/reviews";

describe("delivered review feedback", () => {
  it("preserves restaurant and rider ratings while discarding unverified money", async () => {
    const writes: Array<{path: string; values: Record<string, unknown>}> = [];
    const recordRatings = vi.fn(async () => undefined);
    const result = await recordDeliveredReviewFeedback({
      customerId: "customer-1",
      orderId: "order-1",
      restaurantId: "restaurant-1",
      riderId: "rider-1",
      restaurantRating: 5,
      riderRating: 4,
      postDeliveryTip: 50,
      growthContribution: 20,
    }, {
      database: {
        ref: (path: string) => ({
          update: async (values: Record<string, unknown>) => { writes.push({path, values}); },
        }),
      },
      recordRatings,
    });

    expect(result).toEqual({unverifiedMoneyDiscarded: true});
    expect(recordRatings).toHaveBeenCalledWith(expect.objectContaining({
      restaurantRating: 5,
      riderRating: 4,
    }));
    expect(writes).toEqual([{
      path: `${ROOT}/reviews/customer-1/order-1`,
      values: {postDeliveryTip: 0, growthContribution: 0},
    }]);
    expect(writes.some(({path}) => /riderJobs|riderWallets|financialLedger|ledger/i.test(path))).toBe(false);
  });

  it("does not write money or mutate financial state for ordinary zero-value feedback", async () => {
    const writes: string[] = [];
    const recordRatings = vi.fn(async () => undefined);
    const result = await recordDeliveredReviewFeedback({
      customerId: "customer-1",
      orderId: "order-2",
      restaurantId: "restaurant-1",
      riderId: "rider-1",
      restaurantRating: 4,
      riderRating: 5,
      postDeliveryTip: 0,
      growthContribution: 0,
    }, {
      database: {ref: (path: string) => ({update: async () => { writes.push(path); }})},
      recordRatings,
    });

    expect(result).toEqual({unverifiedMoneyDiscarded: false});
    expect(writes).toEqual([]);
    expect(recordRatings).toHaveBeenCalledTimes(1);
  });

  it("treats malformed, string and negative monetary fields as unverified", () => {
    expect(containsUnverifiedReviewMoney({postDeliveryTip: "0"})).toBe(true);
    expect(containsUnverifiedReviewMoney({postDeliveryTip: -10})).toBe(true);
    expect(containsUnverifiedReviewMoney({growthContribution: "not-a-number"})).toBe(true);
    expect(containsUnverifiedReviewMoney({postDeliveryTip: 0, growthContribution: 0})).toBe(false);
    expect(containsUnverifiedReviewMoney({})).toBe(false);
  });
});
