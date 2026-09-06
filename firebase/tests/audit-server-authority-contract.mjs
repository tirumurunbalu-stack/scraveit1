#!/usr/bin/env node

import {readFileSync} from "node:fs";
import {basename, dirname, isAbsolute, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  CLIENT_FORBIDDEN_JOB_WRITES,
  SAFE_RIDER_ARRIVAL_PHASE_WRITE,
  SAFE_RIDER_ARRIVAL_TIME_WRITE,
  nodeAt,
} from "../tools/build-server-authority-stage4.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const suppliedPath = process.argv[2] || "firebase/feastly-realtime-database-rules.query-indexes-stage3.json";
const targetPath = isAbsolute(suppliedPath) ? suppliedPath : join(repositoryRoot, suppliedPath);
const target = JSON.parse(readFileSync(targetPath, "utf8"));
const feastly = nodeAt(target, ["rules", "feastly"]);
const failures = [];

function summarize(value) {
  const serialized = JSON.stringify(value);
  return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) failures.push(`${label}: expected ${summarize(expected)}, found ${summarize(actual)}`);
}

function collectWriteGrants(node, prefix, output = []) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return output;
  if (Object.hasOwn(node, ".write") && node[".write"] !== false) {
    const expression = String(node[".write"]);
    output.push(`${prefix}/.write = ${expression.length > 180 ? `${expression.slice(0, 177)}...` : expression}`);
  }
  for (const [key, child] of Object.entries(node)) {
    if (!key.startsWith(".")) collectWriteGrants(child, `${prefix}/${key}`, output);
  }
  return output;
}

for (const [path, label] of [
  [["orders", "$uid", "$orderId"], "canonical order"],
  [["restaurantOrders", "$restaurantId", "$uid", "$orderId"], "restaurant order projection"],
  [["dispatchQueue", "$orderId"], "dispatch queue/claim"],
]) {
  const grants = collectWriteGrants(nodeAt(feastly, path), `/feastly/${path.join("/")}`);
  if (grants.length) failures.push(`${label} still has client write grants:\n  ${grants.join("\n  ")}`);
}

const riderJob = nodeAt(feastly, ["riderJobs", "$riderId", "$orderId"]);
requireEqual(riderJob[".write"], false, "rider job creation/replacement must be server-only");
for (const field of CLIENT_FORBIDDEN_JOB_WRITES) {
  requireEqual(nodeAt(riderJob, [field])[".write"], false, `riderJobs/${field} must be server-only`);
}
requireEqual(nodeAt(riderJob, ["phase"])[".write"], SAFE_RIDER_ARRIVAL_PHASE_WRITE, "rider phase must be limited to the arrival marker");
requireEqual(nodeAt(riderJob, ["arrivedRestaurantAt"])[".write"], SAFE_RIDER_ARRIVAL_TIME_WRITE, "restaurant arrival timestamp must be one-time and assigned-rider only");

const review = nodeAt(feastly, ["reviews", "$uid", "$orderId"]);
requireEqual(
  nodeAt(review, ["postDeliveryTip"])[".validate"],
  "newData.isNumber() && newData.val() === 0",
  "unverified post-delivery tip must be zero",
);
requireEqual(
  nodeAt(review, ["growthContribution"])[".validate"],
  "newData.isNumber() && newData.val() === 0",
  "unverified growth contribution must be zero",
);

if (failures.length) {
  console.error(`Server-authority contract FAILED for ${basename(targetPath)} (${failures.length} finding(s)):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Server-authority contract passed for ${basename(targetPath)}.`);
}
