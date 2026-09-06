#!/usr/bin/env node

import {readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const firebaseDirectory = resolve(toolDirectory, "..");

export const stage3Path = join(firebaseDirectory, "feastly-realtime-database-rules.query-indexes-stage3.json");
export const stage4Path = join(firebaseDirectory, "feastly-realtime-database-rules.server-authority-stage4.json");

export const CLIENT_FORBIDDEN_JOB_WRITES = Object.freeze([
  "status",
  "updatedAt",
  "completedAt",
  "earning",
  "orderStatus",
  "handoverAt",
]);

// Arrival at the restaurant is the only legacy Rider-client marker retained in
// stage 4. It is deliberately unable to advance the canonical order, assign a
// rider, complete a delivery, or create a financial entry. The corresponding
// native screen currently sends phase + arrivedRestaurantAt in one PATCH.
export const SAFE_RIDER_ARRIVAL_PHASE_WRITE =
  "auth != null && auth.uid === $riderId && root.child('feastly/riders').child(auth.uid).child('status').val() === 'approved' && root.child('feastly/orders').child(data.parent().child('customerId').val()).child($orderId).child('riderId').val() === auth.uid && (data.val() === newData.val() || (data.val() === 'pickup' && newData.val() === 'at_restaurant'))";

export const SAFE_RIDER_ARRIVAL_TIME_WRITE =
  "auth != null && auth.uid === $riderId && root.child('feastly/riders').child(auth.uid).child('status').val() === 'approved' && root.child('feastly/orders').child(data.parent().child('customerId').val()).child($orderId).child('riderId').val() === auth.uid && !data.exists()";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function nodeAt(root, path) {
  return path.reduce((node, segment) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || !(segment in node)) {
      throw new Error(`Rules path does not exist: ${path.join("/")}`);
    }
    return node[segment];
  }, root);
}

// Replace every inherited client grant below an authoritative aggregate. This
// keeps its validation/schema documentation intact while making Functions
// (Admin SDK) the only writer.
export function denyAllNestedWrites(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (Object.hasOwn(node, ".write")) node[".write"] = false;
  for (const [key, child] of Object.entries(node)) {
    if (!key.startsWith(".")) denyAllNestedWrites(child);
  }
}

export function enforceServerAuthority(source) {
  const result = clone(source);
  const feastly = nodeAt(result, ["rules", "feastly"]);

  // Orders and restaurant projections are priced and transitioned only by the
  // authenticated/App-Checked Functions service. Admin SDK writes bypass RTDB
  // rules; Android clients cannot forge orders or bypass transition checks.
  denyAllNestedWrites(nodeAt(feastly, ["orders", "$uid", "$orderId"]));
  denyAllNestedWrites(nodeAt(feastly, ["restaurantOrders", "$restaurantId", "$uid", "$orderId"]));

  // Dispatch waves, offers, claims and assignment are one atomic server-owned
  // workflow. This removes the older self-claim compatibility path.
  denyAllNestedWrites(nodeAt(feastly, ["dispatchQueue", "$orderId"]));

  const riderJob = nodeAt(feastly, ["riderJobs", "$riderId", "$orderId"]);
  riderJob[".write"] = false;
  for (const field of CLIENT_FORBIDDEN_JOB_WRITES) {
    nodeAt(riderJob, [field])[".write"] = false;
  }
  nodeAt(riderJob, ["phase"])[".write"] = SAFE_RIDER_ARRIVAL_PHASE_WRITE;
  nodeAt(riderJob, ["arrivedRestaurantAt"])[".write"] = SAFE_RIDER_ARRIVAL_TIME_WRITE;

  // A review is not a payment rail. Until a verified post-delivery payment
  // callable and immutable ledger entry exist, clients may submit ratings but
  // cannot turn review fields into rider earnings or platform contributions.
  const review = nodeAt(feastly, ["reviews", "$uid", "$orderId"]);
  nodeAt(review, ["postDeliveryTip"])[".validate"] = "newData.isNumber() && newData.val() === 0";
  nodeAt(review, ["growthContribution"])[".validate"] = "newData.isNumber() && newData.val() === 0";

  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage3 = JSON.parse(readFileSync(stage3Path, "utf8"));
  const stage4 = enforceServerAuthority(stage3);
  writeFileSync(stage4Path, `${JSON.stringify(stage4, null, 2)}\n`, {encoding: "utf8", mode: 0o644});
  console.log("Generated server-authority stage 4 from query-indexes stage 3 (no active rules changed). ");
}
