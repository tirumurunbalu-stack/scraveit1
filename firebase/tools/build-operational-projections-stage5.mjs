#!/usr/bin/env node

import {readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const firebaseDirectory = resolve(toolDirectory, "..");

export const stage4Path = join(firebaseDirectory, "feastly-realtime-database-rules.server-authority-stage4.json");
export const stage5Path = join(firebaseDirectory, "feastly-realtime-database-rules.operational-projections-stage5.json");

export const OPERATIONAL_ORDER_INDEXES = Object.freeze(["activeSortKey", "recentSortKey"]);
export const OPERATIONAL_ORDER_RULE_PATH = Object.freeze([
  "rules",
  "feastly",
  "private",
  "operations",
  "orders",
]);
export const FINANCIAL_LEDGER_INDEXES = Object.freeze(["occurredAt"]);
export const FINANCIAL_LEDGER_RULE_PATH = Object.freeze([
  "rules",
  "feastly",
  "private",
  "financialLedger",
  "journals",
]);
export const RIDER_WALLET_INDEXES = Object.freeze(["codOutstanding"]);
export const RIDER_WALLET_RULE_PATH = Object.freeze([
  "rules",
  "feastly",
  "riderWallets",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeIndexOn(value) {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [...value];
  throw new Error("Unexpected .indexOn shape in staged rules.");
}

function ensureObjectPath(root, path) {
  return path.reduce((node, segment) => {
    if (!Object.hasOwn(node, segment)) node[segment] = {};
    if (!node[segment] || typeof node[segment] !== "object" || Array.isArray(node[segment])) {
      throw new Error(`Rules path is not an object: ${path.join("/")}`);
    }
    return node[segment];
  }, root);
}

/**
 * Add only the indexes used by bounded operator queries. Existing stage-4
 * authorization remains intact, so this transformation changes query planning
 * without granting any new client read or write access.
 */
export function addOperationalProjectionIndexes(source) {
  const result = clone(source);
  const orders = ensureObjectPath(result, OPERATIONAL_ORDER_RULE_PATH);
  orders[".indexOn"] = [...new Set([
    ...normalizeIndexOn(orders[".indexOn"]),
    ...OPERATIONAL_ORDER_INDEXES,
  ])].sort();
  const journals = ensureObjectPath(result, FINANCIAL_LEDGER_RULE_PATH);
  journals[".indexOn"] = [...new Set([
    ...normalizeIndexOn(journals[".indexOn"]),
    ...FINANCIAL_LEDGER_INDEXES,
  ])].sort();
  const riderWallets = ensureObjectPath(result, RIDER_WALLET_RULE_PATH);
  riderWallets[".indexOn"] = [...new Set([
    ...normalizeIndexOn(riderWallets[".indexOn"]),
    ...RIDER_WALLET_INDEXES,
  ])].sort();
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage4 = JSON.parse(readFileSync(stage4Path, "utf8"));
  const stage5 = addOperationalProjectionIndexes(stage4);
  writeFileSync(stage5Path, `${JSON.stringify(stage5, null, 2)}\n`, {encoding: "utf8", mode: 0o644});
  console.log("Generated bounded operations/ledger/COD-query indexes in stage 5 (active rules/config unchanged).");
}
