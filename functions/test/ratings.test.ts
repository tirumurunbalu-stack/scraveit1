import {describe, expect, it} from "vitest";
import {addRatingContribution} from "../src/domain/ratings";

describe("rating aggregates", () => {
  it("adds a rating and calculates the public average", () => {
    expect(addRatingContribution(null, "review-a", 5, 1000)).toEqual({
      count: 1,
      total: 5,
      average: 5,
      contributions: {"review-a": 5},
      updatedAt: 1000,
    });
  });

  it("updates averages without losing precision", () => {
    const current = addRatingContribution(null, "review-a", 5, 1000)!;
    expect(addRatingContribution(current, "review-b", 4, 2000)?.average).toBe(4.5);
  });

  it("is idempotent for a repeated review event", () => {
    const current = addRatingContribution(null, "review-a", 5, 1000)!;
    expect(addRatingContribution(current, "review-a", 5, 2000)).toBeUndefined();
  });

  it("rejects missing or invalid ratings", () => {
    expect(addRatingContribution(null, "review-a", 0)).toBeUndefined();
    expect(addRatingContribution(null, "review-a", 6)).toBeUndefined();
  });
});
