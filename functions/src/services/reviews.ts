import {firestoreDb} from "../admin";
import type {FirestoreLike} from "../firestoreTypes";
import {recordDeliveredOrderRatings} from "./ratings";

type ReviewDatabase = FirestoreLike;

function reviewRef(database: ReviewDatabase, customerId: string, orderId: string) {
  return database.collection("reviews").doc(`${customerId}_${orderId}`);
}

export type DeliveredReviewFeedback = {
  customerId: string;
  orderId: string;
  restaurantId: string;
  riderId?: string;
  restaurantRating: unknown;
  riderRating: unknown;
  postDeliveryTip?: unknown;
  growthContribution?: unknown;
};

type ReviewFeedbackDependencies = {
  database: ReviewDatabase;
  recordRatings: typeof recordDeliveredOrderRatings;
};

const defaultDependencies: ReviewFeedbackDependencies = {
  database: firestoreDb,
  recordRatings: recordDeliveredOrderRatings,
};

function isMissingOrNumericZero(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "number" && value === 0);
}

/**
 * Ratings are feedback, not a payment rail. Until a verified post-delivery
 * payment flow exists, any monetary value attached to a review is untrusted
 * client input and must never reach rider jobs, wallets, or the ledger.
 */
export function containsUnverifiedReviewMoney(input: Pick<DeliveredReviewFeedback, "postDeliveryTip" | "growthContribution">): boolean {
  return !isMissingOrNumericZero(input.postDeliveryTip) ||
    !isMissingOrNumericZero(input.growthContribution);
}

export async function recordDeliveredReviewFeedback(
  input: DeliveredReviewFeedback,
  dependencies: ReviewFeedbackDependencies = defaultDependencies,
): Promise<{unverifiedMoneyDiscarded: boolean}> {
  const unverifiedMoneyDiscarded = containsUnverifiedReviewMoney(input);

  if (unverifiedMoneyDiscarded) {
    await reviewRef(dependencies.database, input.customerId, input.orderId)
      .set({postDeliveryTip: 0, growthContribution: 0}, {merge: true});
  }

  await dependencies.recordRatings({
    customerId: input.customerId,
    orderId: input.orderId,
    restaurantId: input.restaurantId,
    ...(input.riderId ? {riderId: input.riderId} : {}),
    restaurantRating: input.restaurantRating,
    riderRating: input.riderRating,
  });

  return {unverifiedMoneyDiscarded};
}
