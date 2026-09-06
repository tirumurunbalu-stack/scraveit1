import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";

const project = process.env.FIREBASE_PROJECT || "savrivo-app";
const instance = process.env.FIREBASE_DATABASE_INSTANCE || "savrivo-app-default-rtdb";
const root = "feastly";

function firebase(args) {
  const result = spawnSync("firebase", [...args, "--project", project, "--instance", instance], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) process.exit(result.status || 1);
  return result.stdout.trim();
}

function get(path) {
  const value = firebase(["database:get", path]);
  return value && value !== "null" ? JSON.parse(value) : null;
}

function update(path, value) {
  firebase(["database:update", path, "--data", JSON.stringify(value), "--force"]);
}

function contributionId(customerId, orderId) {
  return createHash("sha256").update(`${customerId}:${orderId}`).digest("hex");
}

function aggregateReviews(reviews, ratingField, subjectField) {
  const result = new Map();
  for (const [customerId, customerReviews] of Object.entries(reviews || {})) {
    for (const [orderId, review] of Object.entries(customerReviews || {})) {
      const subjectId = String(review?.[subjectField] || "");
      const rating = Number(review?.[ratingField]);
      if (!subjectId || !Number.isFinite(rating) || rating < 1 || rating > 5) continue;
      const current = result.get(subjectId) || {};
      current[contributionId(customerId, orderId)] = rating;
      result.set(subjectId, current);
    }
  }
  return result;
}

function mergeAggregate(existing, contributions) {
  const merged = {...(existing?.contributions || {}), ...contributions};
  const values = Object.values(merged).map(Number).filter((value) => value >= 1 && value <= 5);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    contributions: merged,
    count: values.length,
    total,
    average: values.length ? Math.round((total / values.length) * 100) / 100 : 0,
    updatedAt: Date.now(),
  };
}

const reviews = get(`/${root}/reviews`) || {};
const restaurants = aggregateReviews(reviews, "rating", "restaurantId");
const riders = aggregateReviews(reviews, "riderRating", "riderId");

for (const [restaurantId, contributions] of restaurants) {
  const aggregate = mergeAggregate(get(`/${root}/ratingAggregates/restaurants/${restaurantId}`), contributions);
  update(`/${root}/ratingAggregates/restaurants/${restaurantId}`, aggregate);
  update(`/${root}/catalog/restaurants/${restaurantId}`, {rating: aggregate.average, ratingCount: aggregate.count});
  console.log(`Backfilled restaurant ${restaurantId}: ${aggregate.average} (${aggregate.count})`);
}

for (const [riderId, contributions] of riders) {
  const aggregate = mergeAggregate(get(`/${root}/ratingAggregates/riders/${riderId}`), contributions);
  update(`/${root}/ratingAggregates/riders/${riderId}`, aggregate);
  update(`/${root}/riders/${riderId}`, {rating: aggregate.average, ratingCount: aggregate.count});
  console.log(`Backfilled rider ${riderId}: ${aggregate.average} (${aggregate.count})`);
}

