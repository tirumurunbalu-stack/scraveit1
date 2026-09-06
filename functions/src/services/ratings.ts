import {createHash} from "node:crypto";
import {db} from "../admin";
import {ROOT} from "../config";
import {addRatingContribution, boundedRating, type RatingAggregate} from "../domain/ratings";

async function recordAggregate(kind: "restaurants" | "riders", subjectId: string, reviewKey: string, rating: number): Promise<RatingAggregate | null> {
  const contributionId = createHash("sha256").update(reviewKey).digest("hex");
  const ref = db.ref(`${ROOT}/ratingAggregates/${kind}/${subjectId}`);
  const result = await ref.transaction((current: RatingAggregate | null) =>
    addRatingContribution(current, contributionId, rating), undefined, false);
  if (!result.committed && !result.snapshot.exists()) return null;
  return result.snapshot.val() as RatingAggregate;
}

export async function recordDeliveredOrderRatings(input: {
  customerId: string;
  orderId: string;
  restaurantId: string;
  riderId?: string;
  restaurantRating: unknown;
  riderRating: unknown;
}): Promise<void> {
  const reviewKey = `${input.customerId}:${input.orderId}`;
  const restaurant = await recordAggregate("restaurants", input.restaurantId, reviewKey, boundedRating(input.restaurantRating));
  if (restaurant) {
    await db.ref(`${ROOT}/catalog/restaurants/${input.restaurantId}`).transaction((current: Record<string, unknown> | null) => {
      if (!current || Number(current.ratingCount ?? 0) > restaurant.count) return undefined;
      return {...current, rating: restaurant.average, ratingCount: restaurant.count};
    }, undefined, false);
  }

  if (!input.riderId || !boundedRating(input.riderRating)) return;
  const rider = await recordAggregate("riders", input.riderId, reviewKey, boundedRating(input.riderRating));
  if (rider) {
    await db.ref(`${ROOT}/riders/${input.riderId}`).transaction((current: Record<string, unknown> | null) => {
      if (!current || Number(current.ratingCount ?? 0) > rider.count) return undefined;
      return {...current, rating: rider.average, ratingCount: rider.count};
    }, undefined, false);
  }
}
