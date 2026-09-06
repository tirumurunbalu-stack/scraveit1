#!/usr/bin/env node

import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DEFAULT_FINANCE_POLICY, normalizeFinancePolicy} from "../lib/domain/financePolicy.js";
import {deterministicJournalId} from "../lib/domain/ledger.js";

const ROOT = "feastly";
const DEFAULT_MAX_ORDERS = 500;

function positiveInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseOptions(argv) {
  const options = {
    apply: false,
    maxOrders: DEFAULT_MAX_ORDERS,
  };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg.startsWith("--max-orders=")) {
      options.maxOrders = positiveInteger(arg.slice("--max-orders=".length), "max-orders", 1, 10000);
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "Backfill immutable COD delivery ledger journals from canonical delivered orders (dry-run by default).",
    "",
    "Required environment:",
    "  SAVRIVO_EXPECTED_PROJECT_ID=<exact Firebase project id>",
    "  SAVRIVO_DATABASE_URL=<exact Realtime Database URL>",
    "",
    "Apply additionally requires:",
    "  SAVRIVO_CONFIRM_PROJECT_ID=<same exact project id>",
    "",
    "Options:",
    "  --apply                         enable database writes",
    "  --max-orders=500                maximum canonical orders scanned this run (1..10000)",
  ].join("\n");
}

function databaseFingerprint(databaseUrl) {
  return createHash("sha256").update(databaseUrl).digest("hex").slice(0, 16);
}

function requireEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function firebaseJson(projectId, path) {
  const raw = execFileSync("firebase", ["database:get", path, "--project", projectId], {encoding: "utf8"});
  return JSON.parse(raw || "null");
}

function firebaseSet(projectId, path, value) {
  const directory = mkdtempSync(join(tmpdir(), "savrivo-ledger-backfill-"));
  const file = join(directory, "payload.json");
  try {
    writeFileSync(file, `${JSON.stringify(value)}\n`, {encoding: "utf8", mode: 0o600});
    execFileSync("firebase", [
      "database:set",
      path,
      file,
      "--project",
      projectId,
      "--force",
      "--disable-triggers",
    ], {encoding: "utf8"});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

function objectEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

function inspectOrder(raw, customerId, orderId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {kind: "skip"};
  if (String(raw.id ?? "") !== orderId || String(raw.customerId ?? "") !== customerId) return {kind: "skip"};
  if (String(raw.status ?? "") !== "Delivered") return {kind: "skip"};
  if (!String(raw.restaurantId ?? "") || !String(raw.riderId ?? "")) return {kind: "unsupported", reason: "DELIVERED_ORDER_MISSING_PARTIES"};
  if (String(raw.paymentMethod ?? "") !== "cod") return {kind: "unsupported", reason: "DELIVERED_ORDER_REQUIRES_ONLINE_PAYMENT_PROOF"};
  if (!raw.pricing || typeof raw.pricing !== "object" || Array.isArray(raw.pricing)) {
    return {kind: "unsupported", reason: "DELIVERED_ORDER_MISSING_PRICING"};
  }
  if (!Number.isFinite(Number(raw.total)) || !Number.isFinite(Number(raw.updatedAt))) {
    return {kind: "unsupported", reason: "DELIVERED_ORDER_INVALID_TOTAL_OR_TIMESTAMP"};
  }
  return {kind: "candidate", order: raw};
}

function markerForRider(riderId, verifiedAt) {
  return {
    schemaVersion: 1,
    riderId,
    historicalBackfillComplete: true,
    verifiedAt,
  };
}

function markerForRestaurant(restaurantId, verifiedAt) {
  return {
    schemaVersion: 1,
    restaurantId,
    historicalBackfillComplete: true,
    verifiedAt,
  };
}

function journalPathForOrder(orderId) {
  return `${ROOT}/private/financialLedger/journals/${deterministicJournalId("cod_delivery", `order:${orderId}:delivered:cod`)}`;
}

function coveragePathForRider(riderId) {
  return `${ROOT}/private/financialLedger/coverage/riders/${riderId}`;
}

function coveragePathForRestaurant(restaurantId) {
  return `${ROOT}/private/financialLedger/coverage/restaurants/${restaurantId}`;
}

function persistedFingerprint(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? String(value.fingerprint ?? "") : "";
}

function financePolicy(projectId) {
  const value = firebaseJson(projectId, `/${ROOT}/platformConfig/finance`);
  return normalizeFinancePolicy(value ?? DEFAULT_FINANCE_POLICY);
}

function persistIfChanged(projectId, path, next, apply, counters, counterKey) {
  const current = firebaseJson(projectId, `/${path}`);
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  if (!apply) {
    counters[counterKey] += 1;
    return;
  }
  firebaseSet(projectId, `/${path}`, next);
  counters[counterKey.replace("Planned", "Applied")] += 1;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const projectId = requireEnv("SAVRIVO_EXPECTED_PROJECT_ID");
  const databaseUrl = requireEnv("SAVRIVO_DATABASE_URL");
  if (options.apply && requireEnv("SAVRIVO_CONFIRM_PROJECT_ID") !== projectId) {
    throw new Error("SAVRIVO_CONFIRM_PROJECT_ID must exactly match SAVRIVO_EXPECTED_PROJECT_ID.");
  }
  process.env.FIREBASE_CONFIG = JSON.stringify({
    projectId,
    databaseURL: databaseUrl,
  });
  const {buildCodOrderDeliveryJournal, orderDeliveryAmounts} = await import("../lib/services/ledger.js");

  const counters = {
    ordersVisited: 0,
    deliveredOrdersVisited: 0,
    unsupportedDeliveredOrders: 0,
    journalWritesPlanned: 0,
    journalWritesApplied: 0,
    journalAlreadyPresent: 0,
    coverageWritesPlanned: 0,
    coverageWritesApplied: 0,
  };
  const riders = new Set();
  const restaurants = new Set();
  const failures = [];
  const ordersByCustomer = firebaseJson(projectId, `/${ROOT}/orders`);
  const policy = financePolicy(projectId);

  for (const [customerId, orders] of objectEntries(ordersByCustomer)) {
    for (const [orderId, raw] of objectEntries(orders)) {
      counters.ordersVisited += 1;
      if (counters.ordersVisited > options.maxOrders) {
        throw new Error(`Aborted after ${options.maxOrders} orders. Increase --max-orders to continue safely.`);
      }
      const inspected = inspectOrder(raw, customerId, orderId);
      if (inspected.kind === "skip") continue;
      counters.deliveredOrdersVisited += 1;
      if (inspected.kind === "unsupported") {
        counters.unsupportedDeliveredOrders += 1;
        failures.push({orderId, reason: inspected.reason});
        continue;
      }

      const {order} = inspected;
      riders.add(String(order.riderId));
      restaurants.add(String(order.restaurantId));
      let journal;
      try {
        const amounts = orderDeliveryAmounts(order, policy.restaurantCommissionBps);
        journal = buildCodOrderDeliveryJournal({
          ...amounts,
          orderId: order.id,
          restaurantId: order.restaurantId,
          riderId: order.riderId,
          occurredAt: Number(order.deliveredAt ?? order.updatedAt),
        });
      } catch (error) {
        failures.push({orderId, reason: String(error?.message ?? error)});
        continue;
      }

      const path = journalPathForOrder(order.id);
      const existing = firebaseJson(projectId, `/${path}`);
      if (existing !== null) {
        if (persistedFingerprint(existing) !== journal.fingerprint) {
          failures.push({orderId, reason: "IMMUTABLE_LEDGER_CONFLICT"});
        } else {
          counters.journalAlreadyPresent += 1;
        }
        continue;
      }
      if (!options.apply) {
        counters.journalWritesPlanned += 1;
        continue;
      }
      firebaseSet(projectId, `/${path}`, journal);
      counters.journalWritesApplied += 1;
    }
  }

  if (failures.length) {
    console.log(JSON.stringify({
      projectId,
      databaseFingerprint: databaseFingerprint(databaseUrl),
      applied: options.apply,
      ...counters,
      failureCount: failures.length,
      failures,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const verifiedAt = Date.now();
  for (const riderId of [...riders].sort()) {
    persistIfChanged(
      projectId,
      coveragePathForRider(riderId),
      markerForRider(riderId, verifiedAt),
      options.apply,
      counters,
      "coverageWritesPlanned",
    );
  }
  for (const restaurantId of [...restaurants].sort()) {
    persistIfChanged(
      projectId,
      coveragePathForRestaurant(restaurantId),
      markerForRestaurant(restaurantId, verifiedAt),
      options.apply,
      counters,
      "coverageWritesPlanned",
    );
  }

  console.log(JSON.stringify({
    projectId,
    databaseFingerprint: databaseFingerprint(databaseUrl),
    applied: options.apply,
    financePolicy: policy,
    ...counters,
    riderCoverageTargets: [...riders].sort().length,
    restaurantCoverageTargets: [...restaurants].sort().length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
