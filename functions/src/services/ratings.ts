import {createHash} from "node:crypto";
import {firestoreDb} from "../admin";
import {addRatingContribution, boundedRating, type RatingAggregate} from "../domain/ratings";
import type {DocumentReferenceLike, FirestoreLike, TransactionLike} from "../firestoreTypes";
import {restaurantRef, riderRef} from "../firestorePaths";

function ratingAggregateRef(database: FirestoreLike, kind: "restaurants" | "riders", subjectId: string): DocumentReferenceLike {
  return database.collection("ratingAggregates").doc(kind).collection("subjects").doc(subjectId);
}

async function recordAggregate(kind: "restaurants" | "riders", subjectId: string, reviewKey: string, rating: number): Promise<RatingAggregate | null> {
  const contributionId = createHash("sha256").update(reviewKey).digest("hex");
  const ref = ratingAggregateRef(firestoreDb, kind, subjectId);
  return firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as RatingAggregate : null;
    const next = addRatingContribution(current, contributionId, rating);
    if (next === undefined) return current ?? null;
    transaction.set(ref, next);
    return next;
  });
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
    const ref = restaurantRef(firestoreDb, input.restaurantId);
    await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() as Record<string, unknown> : null;
      if (!current || Number(current.ratingCount ?? 0) > restaurant.count) return;
      transaction.set(ref, {...current, rating: restaurant.average, ratingCount: restaurant.count});
    });
  }

  if (!input.riderId || !boundedRating(input.riderRating)) return;
  const rider = await recordAggregate("riders", input.riderId, reviewKey, boundedRating(input.riderRating));
  if (rider) {
    const ref = riderRef(firestoreDb, input.riderId);
    await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() as Record<string, unknown> : null;
      if (!current || Number(current.ratingCount ?? 0) > rider.count) return;
      transaction.set(ref, {...current, rating: rider.average, ratingCount: rider.count});
    });
  }
}
