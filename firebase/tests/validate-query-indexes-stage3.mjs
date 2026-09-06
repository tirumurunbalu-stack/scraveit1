#!/usr/bin/env node

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  REVIEWED_QUERY_INDEXES,
  addReviewedQueryIndexes,
  normalizeIndexOn,
} from "../tools/build-query-indexes-stage3.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const pathFromRoot = (path) => join(repositoryRoot, path);
const readJson = (path) => JSON.parse(readFileSync(pathFromRoot(path), "utf8"));
const readText = (path) => readFileSync(pathFromRoot(path), "utf8");

const active = readJson("firebase/feastly-realtime-database-rules.json");
const stage2 = readJson("firebase/feastly-realtime-database-rules.admin-claims-stage2.json");
const stage3 = readJson("firebase/feastly-realtime-database-rules.query-indexes-stage3.json");
const defaultConfig = readJson("firebase.json");
const stage3Config = readJson("firebase/firebase.query-indexes-stage3.json");
const stage3Generator = readText("firebase/tools/build-query-indexes-stage3.mjs");

assert.deepEqual(
  stage3,
  addReviewedQueryIndexes(stage2),
  "Stage 3 may only add the explicitly reviewed .indexOn declarations to stage 2.",
);
assert.equal(REVIEWED_QUERY_INDEXES.length, 1, "Every new staged index needs an explicit source-query review.");
assert.deepEqual(
  normalizeIndexOn(stage3.rules.feastly.promotions[".indexOn"]),
  ["code"],
  "Coupon lookup requires the promotions/code index.",
);

// Existing indexed production queries must remain covered.
assert.ok(normalizeIndexOn(stage3.rules.feastly.catalog.restaurants[".indexOn"]).includes("city"));
assert.ok(normalizeIndexOn(stage3.rules.feastly.dispatchQueue[".indexOn"]).includes("status"));
assert.ok(normalizeIndexOn(stage3.rules.feastly.staff[".indexOn"]).includes("restaurantId"));
assert.ok(normalizeIndexOn(stage3.rules.feastly.private.notificationOutbox[".indexOn"]).includes("nextAttemptAt"));
assert.ok(normalizeIndexOn(active.rules.feastly.private.notificationOutbox[".indexOn"]).includes("nextAttemptAt"));

assert.equal(
  defaultConfig.database?.rules,
  "firebase/feastly-realtime-database-rules.json",
  "The default deployment target must remain the active-compatible rules.",
);
assert.deepEqual(Object.keys(stage3Config), ["database"], "Stage-3 config must deploy only Realtime Database rules.");
assert.equal(
  stage3Config.database?.rules,
  "feastly-realtime-database-rules.query-indexes-stage3.json",
  "The isolated stage-3 config must target only the additive index artifact.",
);
assert.match(
  stage3Generator,
  /writeFileSync\(stage3Path,/,
  "The generator must write only the dedicated stage-3 artifact.",
);
assert.doesNotMatch(
  stage3Generator,
  /writeFileSync\(stage2Path,/,
  "The generator must never rewrite the stage-2 rules artifact.",
);
assert.deepEqual(active, readJson("firebase/feastly-realtime-database-rules.json"), "Validation must not mutate active rules.");

const catalogService = readText("functions/src/services/catalog.ts");
assert.match(
  catalogService,
  /ref\(`\$\{ROOT\}\/promotions`\)\.orderByChild\("code"\)\.equalTo\(code\)\.limitToFirst\(5\)/,
  "The code index must continue to correspond to a bounded coupon lookup.",
);

const customer = readText("native_android/app/src/main/assets/premium.js");
assert.match(customer, /function restaurantSummaryQuery\(\)/);
assert.match(customer, /orderBy:JSON\.stringify\("city"\).*limitToFirst:"100"/s);
assert.match(
  customer,
  /const parameters=kind==="catalog"\?restaurantSummaryQuery\(\):null;/,
  "Customer catalogue stream must select the same bounded query as the one-shot catalogue read.",
);
assert.match(
  customer,
  /const path=kind==="catalog"\?DB_ROOT\+"\/catalog\/restaurants"/,
  "Customer catalogue stream must continue to observe the restaurant summary path.",
);
assert.match(
  customer,
  /watchPath\(path,\(\)=>scheduleScopedSync\(kind\),parameters/,
  "Customer catalogue SSE must pass its city/limit constraints to the realtime watcher.",
);
assert.match(
  customer,
  /new EventSource\(parameters\s*\? dbQueryUrl\(path, session\.idToken, parameters\)\s*:\s*dbUrl\(path, session\.idToken\)\)/s,
  "Realtime watchers must preserve optional query constraints.",
);

console.log("Query-indexes stage 3 validated: coupon lookup indexed, customer catalogue stream bounded, active rules/config unchanged.");
