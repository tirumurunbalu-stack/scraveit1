#!/usr/bin/env node

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  FINANCIAL_LEDGER_INDEXES,
  FINANCIAL_LEDGER_RULE_PATH,
  OPERATIONAL_ORDER_INDEXES,
  OPERATIONAL_ORDER_RULE_PATH,
  RIDER_WALLET_INDEXES,
  RIDER_WALLET_RULE_PATH,
  addOperationalProjectionIndexes,
  normalizeIndexOn,
} from "../tools/build-operational-projections-stage5.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const pathFromRoot = (path) => join(repositoryRoot, path);
const readJson = (path) => JSON.parse(readFileSync(pathFromRoot(path), "utf8"));
const readText = (path) => readFileSync(pathFromRoot(path), "utf8");

const active = readJson("firebase/feastly-realtime-database-rules.json");
const stage4 = readJson("firebase/feastly-realtime-database-rules.server-authority-stage4.json");
const stage5 = readJson("firebase/feastly-realtime-database-rules.operational-projections-stage5.json");
const defaultConfig = readJson("firebase.json");
const stage5Config = readJson("firebase/firebase.operational-projections-stage5.json");
const generator = readText("firebase/tools/build-operational-projections-stage5.mjs");
const backfill = readText("functions/scripts/backfill-operational-projections.mjs");

function nodeAt(root, path) {
  return path.reduce((node, segment) => {
    assert.ok(node && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, segment),
      `Missing rules path: ${path.join("/")}`);
    return node[segment];
  }, root);
}

assert.deepEqual(
  stage5,
  addOperationalProjectionIndexes(stage4),
  "Stage 5 must be the deterministic index-only transform of stage 4.",
);

const expectedIndexes = [...OPERATIONAL_ORDER_INDEXES].sort();
assert.deepEqual(
  normalizeIndexOn(nodeAt(stage5, OPERATIONAL_ORDER_RULE_PATH)[".indexOn"]),
  expectedIndexes,
  "Operational order queries require activeSortKey and recentSortKey indexes.",
);
assert.deepEqual(
  normalizeIndexOn(nodeAt(stage5, FINANCIAL_LEDGER_RULE_PATH)[".indexOn"]),
  [...FINANCIAL_LEDGER_INDEXES].sort(),
  "Bounded ledger queries require the occurredAt index.",
);
assert.deepEqual(
  normalizeIndexOn(nodeAt(stage5, RIDER_WALLET_RULE_PATH)[".indexOn"]),
  [...RIDER_WALLET_INDEXES].sort(),
  "Bounded positive COD exposure queries require the codOutstanding index.",
);

function stripOperationalIndexes(value) {
  const clone = JSON.parse(JSON.stringify(value));
  const privateNode = clone.rules.feastly.private;
  const orders = privateNode.operations?.orders;
  if (orders) {
    delete orders[".indexOn"];
    if (Object.keys(orders).length === 0) delete privateNode.operations.orders;
    if (Object.keys(privateNode.operations ?? {}).length === 0) delete privateNode.operations;
  }
  const journals = privateNode.financialLedger?.journals;
  if (journals) {
    delete journals[".indexOn"];
    if (Object.keys(journals).length === 0) delete privateNode.financialLedger.journals;
    if (Object.keys(privateNode.financialLedger ?? {}).length === 0) delete privateNode.financialLedger;
  }
  const riderWallets = clone.rules.feastly.riderWallets;
  if (riderWallets) delete riderWallets[".indexOn"];
  return clone;
}

assert.deepEqual(
  stripOperationalIndexes(stage5),
  stage4,
  "The only stage-5 rules diff may be the reviewed bounded operations and ledger indexes.",
);
assert.equal(stage5.rules.feastly.private[".read"], false, "Private projections must remain client-unreadable.");
assert.equal(stage5.rules.feastly.private[".write"], false, "Private projections must remain client-unwritable.");
assert.equal(stage5.rules.feastly.riderWallets[".write"], false,
  "The COD exposure index must not make rider wallets client-writable.");
assert.equal(stage5.rules.feastly.riderWallets[".read"],
  stage4.rules.feastly.riderWallets[".read"],
  "The COD exposure index must not change rider-wallet read authorization.");
assert.deepEqual(stage5.rules.feastly.promotions[".indexOn"], ["code"], "Stage-3 coupon index must remain intact.");

assert.equal(defaultConfig.database?.rules, "firebase/feastly-realtime-database-rules.json",
  "Default firebase.json must continue to target the active-compatible rules.");
assert.deepEqual(Object.keys(stage5Config), ["database"], "Stage-5 config may deploy only Realtime Database rules.");
assert.equal(stage5Config.database?.rules, "feastly-realtime-database-rules.operational-projections-stage5.json");
assert.match(generator, /writeFileSync\(stage5Path,/);
assert.doesNotMatch(generator, /writeFileSync\(stage4Path,/);
assert.deepEqual(active, readJson("firebase/feastly-realtime-database-rules.json"), "Validation must not mutate active rules.");
assert.deepEqual(stage4, readJson("firebase/feastly-realtime-database-rules.server-authority-stage4.json"),
  "Validation must not mutate stage 4.");

// Static fail-safe contract for the operator-only migration utility. Runtime
// tests of the shared projection builders remain in the Functions suite.
assert.match(backfill, /const apply = options\.apply === true/);
assert.match(backfill, /SAVRIVO_EXPECTED_PROJECT_ID is required/);
assert.match(backfill, /SAVRIVO_CONFIRM_PROJECT_ID/);
assert.match(backfill, /if \(!apply\) return/);
assert.match(backfill, /orderByKey\(\)/);
assert.match(backfill, /limitToFirst\(pageSize \+ \(afterKey \? 2 : 1\)\)/);
assert.doesNotMatch(backfill, /console\.log\([^\n]*(customerId|orderId|riderId)/,
  "Backfill logs must not print private identifiers.");

console.log("Operational-projections stage 5 validated: exact bounded operations/ledger/COD index diff, authorization preserved, default deployment unchanged, backfill safety gates present.");
