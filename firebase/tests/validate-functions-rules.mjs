#!/usr/bin/env node

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join, resolve} from "node:path";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const activeRulesPath = join(repositoryRoot, "firebase/feastly-realtime-database-rules.json");
const stagedRulesPath = join(repositoryRoot, "firebase/feastly-realtime-database-rules.production-functions-stage1.json");
const firebaseConfigPath = join(repositoryRoot, "firebase.json");
const stagedFirebaseConfigPath = join(repositoryRoot, "firebase/firebase.production-functions-stage1.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const active = readJson(activeRulesPath);
const staged = readJson(stagedRulesPath);
const firebaseConfig = readJson(firebaseConfigPath);
const stagedFirebaseConfig = readJson(stagedFirebaseConfigPath);
const activeFeastly = active.rules?.feastly;
const stagedFeastly = staged.rules?.feastly;

assert.ok(activeFeastly && stagedFeastly, "Both rules files must contain /feastly rules.");
assert.equal(staged.rules[".write"], false, "No root write grant may bypass protected child rules.");
assert.equal(stagedFeastly[".write"], false, "No /feastly write grant may bypass protected child rules.");
assert.equal(
  firebaseConfig.database?.rules,
  "firebase/feastly-realtime-database-rules.json",
  "The staged file must not become the active deployment target before the rollout gate.",
);
assert.equal(
  stagedFirebaseConfig.database?.rules,
  "feastly-realtime-database-rules.production-functions-stage1.json",
  "The explicit stage-1 Firebase config must point only to the reviewed staged rules file.",
);
assert.deepEqual(
  Object.keys(stagedFirebaseConfig),
  ["database"],
  "The stage-1 config must not deploy Functions, Storage, Hosting, or any other Firebase product.",
);

const additions = [
  "orderIdempotency",
  "backendEvents",
  "paymentAttempts",
  "paymentAttemptsByMerchantOrder",
  "paymentEvents",
  "riderAvailabilityByCity",
  "deviceTokens",
  "pricingSignals",
];

// /private and /riderWallets now also exist in the active rules (admin-scoped,
// carrying the backend query indexes). Stage 1 no longer introduces them; it
// keeps their index schema but locks client authority, so they are validated
// like /restaurantLoad below rather than as brand-new additions.
const hardenedExistingNodes = ["restaurantLoad", "private", "riderWallets"];

assert.deepEqual(
  Object.keys(stagedFeastly).filter((key) => !(key in activeFeastly)).sort(),
  [...additions].sort(),
  "Stage 1 may add only the reviewed backend-owned nodes.",
);

for (const [key, value] of Object.entries(activeFeastly)) {
  if (hardenedExistingNodes.includes(key)) continue;
  assert.deepEqual(
    stagedFeastly[key],
    value,
    `Stage 1 must preserve the active rule subtree /feastly/${key} byte-semantically.`,
  );
}

// /private is fully client-locked in stage 1 but must keep the exact backend
// query index schema it carries in the active rules; only access authority
// (.read/.write) may change.
const privateSchema = (node) =>
  Object.fromEntries(Object.entries(node).filter(([key]) => key !== ".read" && key !== ".write"));
assert.deepEqual(
  privateSchema(stagedFeastly.private),
  privateSchema(activeFeastly.private),
  "Stage 1 may change only /private access authority, not its index schema.",
);
// /riderWallets keeps its active COD index while stage 1 makes it server-write-only.
assert.deepEqual(
  stagedFeastly.riderWallets[".indexOn"],
  activeFeastly.riderWallets[".indexOn"],
  "Stage 1 must preserve the /riderWallets COD index.",
);

assert.equal(
  stagedFeastly.restaurantLoad?.$restaurantId?.[".write"],
  false,
  "/restaurantLoad must become server-write-only with the Functions workload reducer.",
);
assert.deepEqual(
  Object.fromEntries(Object.entries(stagedFeastly.restaurantLoad.$restaurantId).filter(([key]) => key !== ".write")),
  Object.fromEntries(Object.entries(activeFeastly.restaurantLoad.$restaurantId).filter(([key]) => key !== ".write")),
  "Stage 1 may change only restaurantLoad write authority, not its validation schema.",
);

for (const key of ["orderIdempotency", "private", "backendEvents", "deviceTokens"]) {
  assert.equal(stagedFeastly[key][".read"], false, `/${key} must deny every client read.`);
  assert.equal(stagedFeastly[key][".write"], false, `/${key} must deny every client write.`);
}

const adminReadableServerNodes = [
  "paymentAttempts",
  "paymentAttemptsByMerchantOrder",
  "paymentEvents",
  "riderAvailabilityByCity",
  "pricingSignals",
];
for (const key of adminReadableServerNodes) {
  const node = stagedFeastly[key];
  assert.equal(node[".write"], false, `/${key} must be server-write-only.`);
  assert.equal(typeof node[".read"], "string", `/${key} needs an explicit privileged read rule.`);
  assert.match(node[".read"], /auth != null/);
  assert.match(node[".read"], /savrivoRole === 'owner'/);
  assert.match(node[".read"], /savrivoRole === 'ops_admin'/);
}

const wallets = stagedFeastly.riderWallets;
assert.equal(wallets[".write"], false, "/riderWallets must be server-write-only.");
assert.equal(wallets.$riderId[".write"], false, "A rider must not write their own COD ledger.");
assert.match(wallets.$riderId[".read"], /auth\.uid === \$riderId/);
assert.match(wallets.$riderId[".read"], /savrivoRole === 'owner'/);
assert.match(wallets.$riderId[".read"], /savrivoRole === 'ops_admin'/);

// These direct-write paths intentionally remain unchanged in stage 1. Removing
// them before all installed clients use callables would stop live operations.
for (const key of ["orders", "restaurantOrders", "dispatchQueue", "riderJobs", "riderPresence", "tracking", "audit"]) {
  assert.deepEqual(stagedFeastly[key], activeFeastly[key], `Legacy compatibility changed unexpectedly at /${key}.`);
}

const proximityEvidence = activeFeastly.tracking?.$orderId?.proximityEvidence;
assert.ok(proximityEvidence, "Assigned riders need a validated proximity-evidence path for server-owned geofencing.");
assert.match(proximityEvidence[".validate"], /consecutiveFixes/);
assert.match(proximityEvidence[".validate"], /detectedAt/);
assert.match(proximityEvidence[".validate"], /newData\.parent\(\)\.child\('riderId'\)/);
assert.deepEqual(
  Object.keys(proximityEvidence).filter((key) => !key.startsWith(".")).sort(),
  ["$other", "accuracy", "candidate", "consecutiveFixes", "detectedAt", "distanceMeters", "orderId", "phase", "riderId", "source"].sort(),
  "Proximity evidence must expose only the reviewed fields.",
);
assert.equal(proximityEvidence.$other?.[".validate"], false, "Unknown proximity evidence fields must be rejected.");

const functionSources = [
  "functions/src/index.ts",
  "functions/src/services/catalog.ts",
  "functions/src/services/deviceTokens.ts",
  "functions/src/services/dispatch.ts",
  "functions/src/services/orders.ts",
  "functions/src/services/payments.ts",
].map((path) => readFileSync(join(repositoryRoot, path), "utf8")).join("\n");

for (const key of additions) {
  assert.ok(
    functionSources.includes(key),
    `Protected path /feastly/${key} must be backed by an exact Functions source reference.`,
  );
}

console.log(`Functions rules stage 1 validated: ${additions.length} new backend-owned nodes plus restaurantLoad locked; active deployment target unchanged.`);
