#!/usr/bin/env node

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  CLIENT_FORBIDDEN_JOB_WRITES,
  SAFE_RIDER_ARRIVAL_PHASE_WRITE,
  SAFE_RIDER_ARRIVAL_TIME_WRITE,
  enforceServerAuthority,
  nodeAt,
} from "../tools/build-server-authority-stage4.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const pathFromRoot = (path) => join(repositoryRoot, path);
const readJson = (path) => JSON.parse(readFileSync(pathFromRoot(path), "utf8"));
const readText = (path) => readFileSync(pathFromRoot(path), "utf8");

const active = readJson("firebase/feastly-realtime-database-rules.json");
const stage1 = readJson("firebase/feastly-realtime-database-rules.production-functions-stage1.json");
const stage2 = readJson("firebase/feastly-realtime-database-rules.admin-claims-stage2.json");
const stage3 = readJson("firebase/feastly-realtime-database-rules.query-indexes-stage3.json");
const stage4 = readJson("firebase/feastly-realtime-database-rules.server-authority-stage4.json");
const defaultConfig = readJson("firebase.json");
const stage4Config = readJson("firebase/firebase.server-authority-stage4.json");
const stage4Generator = readText("firebase/tools/build-server-authority-stage4.mjs");

assert.deepEqual(stage4, enforceServerAuthority(stage3), "Stage 4 must be the deterministic server-authority transform of stage 3.");

function collectIndexes(node, prefix = "", result = {}) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return result;
  if (Object.hasOwn(node, ".indexOn")) result[prefix] = node[".indexOn"];
  for (const [key, child] of Object.entries(node)) {
    if (!key.startsWith(".")) collectIndexes(child, `${prefix}/${key}`, result);
  }
  return result;
}

assert.deepEqual(collectIndexes(stage4.rules), collectIndexes(stage3.rules), "Stage 4 must preserve every stage-3 query index.");
assert.deepEqual(stage4.rules.feastly.promotions[".indexOn"], ["code"], "Stage 4 must retain the promotions/code index.");

function assertNoClientWriteGrant(node, label) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (Object.hasOwn(node, ".write")) assert.equal(node[".write"], false, `${label} contains a client write grant.`);
  for (const [key, child] of Object.entries(node)) {
    if (!key.startsWith(".")) assertNoClientWriteGrant(child, `${label}/${key}`);
  }
}

const feastly = stage4.rules.feastly;
assertNoClientWriteGrant(nodeAt(feastly, ["orders", "$uid", "$orderId"]), "canonical order");
assertNoClientWriteGrant(nodeAt(feastly, ["restaurantOrders", "$restaurantId", "$uid", "$orderId"]), "restaurant order projection");
assertNoClientWriteGrant(nodeAt(feastly, ["dispatchQueue", "$orderId"]), "dispatch queue");

const riderJob = nodeAt(feastly, ["riderJobs", "$riderId", "$orderId"]);
assert.equal(riderJob[".write"], false);
for (const field of CLIENT_FORBIDDEN_JOB_WRITES) assert.equal(nodeAt(riderJob, [field])[".write"], false);
assert.equal(nodeAt(riderJob, ["phase"])[".write"], SAFE_RIDER_ARRIVAL_PHASE_WRITE);
assert.equal(nodeAt(riderJob, ["arrivedRestaurantAt"])[".write"], SAFE_RIDER_ARRIVAL_TIME_WRITE);

const review = nodeAt(feastly, ["reviews", "$uid", "$orderId"]);
assert.equal(nodeAt(review, ["postDeliveryTip"])[".validate"], "newData.isNumber() && newData.val() === 0");
assert.equal(nodeAt(review, ["growthContribution"])[".validate"], "newData.isNumber() && newData.val() === 0");

assert.equal(defaultConfig.database?.rules, "firebase/feastly-realtime-database-rules.json", "Default deployment target must stay unchanged.");
assert.deepEqual(Object.keys(stage4Config), ["database"], "Stage-4 config may deploy only Realtime Database rules.");
assert.equal(stage4Config.database?.rules, "feastly-realtime-database-rules.server-authority-stage4.json");
assert.match(stage4Generator, /writeFileSync\(stage4Path,/);
assert.doesNotMatch(stage4Generator, /writeFileSync\(stage3Path,/);

// Verify the installed app flows already prefer the authenticated callable
// boundary before the direct compatibility grants are removed.
const customer = readText("native_android/app/src/main/assets/premium.js");
const restaurant = readText("native_android/restaurant/src/main/assets/premium.js");
const rider = readText("native_android/rider/src/main/assets/premium.js");
const admin = readText("native_android/admin/src/main/assets/premium.js");
const functionsIndex = readText("functions/src/index.ts");
const orderService = readText("functions/src/services/orders.ts");
const dispatchService = readText("functions/src/services/dispatch.ts");

assert.match(customer, /const LEGACY_ORDER_WRITE_COMPATIBILITY = false/);
assert.match(customer, /nativeInvoke\("createCodOrder"/);
assert.match(restaurant, /nativeInvoke\("updateOrderStatus"/);
assert.match(rider, /nativeInvoke\("claimRiderOrder"/);
assert.match(rider, /nativeInvoke\("updateOrderStatus"/);
assert.match(admin, /nativeInvoke\("updateOrderStatus"/);
assert.match(functionsIndex, /export const createCodOrder = onCall\(\{[\s\S]*?enforceAppCheck: true/);
assert.match(functionsIndex, /export const updateOrderStatus = onCall\(\{[\s\S]*?enforceAppCheck: true/);
assert.match(functionsIndex, /export const claimRiderOrder = onCall\(\{[\s\S]*?enforceAppCheck: true/);
assert.match(orderService, /export async function createAuthoritativeCodOrder/);
assert.match(orderService, /export async function transitionOrder/);
assert.match(orderService, /verifyPrivateDeliveryOtp/);
assert.match(orderService, /cashCollected/);
assert.match(dispatchService, /export async function claimDispatchOffer/);
assert.match(dispatchService, /transaction\(/);

// Reading these unchanged artifacts after validation also detects accidental
// in-memory mutation by the transform; the default deployment config remains
// deliberately pointed at the active-compatible rules.
assert.deepEqual(active, readJson("firebase/feastly-realtime-database-rules.json"));
assert.deepEqual(stage1, readJson("firebase/feastly-realtime-database-rules.production-functions-stage1.json"));
assert.deepEqual(stage2, readJson("firebase/feastly-realtime-database-rules.admin-claims-stage2.json"));
assert.deepEqual(stage3, readJson("firebase/feastly-realtime-database-rules.query-indexes-stage3.json"));

console.log("Server-authority stage 4 validated: canonical writes server-owned, callable app paths present, stage-3 indexes retained, default deployment unchanged.");
