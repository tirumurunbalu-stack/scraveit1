#!/usr/bin/env node

import {createHash} from "node:crypto";
import {existsSync, readFileSync, renameSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {getDatabase} from "firebase-admin/database";
import {
  buildOperationalOrderProjection,
  shouldApplyOperationalOrderProjection,
} from "../lib/domain/operationalOrders.js";
import {buildRiderOperationalWorkload} from "../lib/domain/riderWorkload.js";

const ROOT = "feastly";
const CHECKPOINT_VERSION = 1;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_MAX_JOBS_PER_RIDER = 5000;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultCheckpointPath = resolve(scriptDirectory, "../.operational-projections-backfill.checkpoint.json");

function positiveInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function parseOptions(argv) {
  const options = {
    apply: false,
    resetCheckpoint: false,
    pageSize: DEFAULT_PAGE_SIZE,
    maxRecords: DEFAULT_MAX_RECORDS,
    maxJobsPerRider: DEFAULT_MAX_JOBS_PER_RIDER,
    checkpointPath: defaultCheckpointPath,
  };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--reset-checkpoint") options.resetCheckpoint = true;
    else if (arg.startsWith("--page-size=")) {
      options.pageSize = positiveInteger(arg.slice("--page-size=".length), "page-size", 1, 500);
    } else if (arg.startsWith("--max-records=")) {
      options.maxRecords = positiveInteger(arg.slice("--max-records=".length), "max-records", 1, 10000);
    } else if (arg.startsWith("--max-jobs-per-rider=")) {
      options.maxJobsPerRider = positiveInteger(
        arg.slice("--max-jobs-per-rider=".length),
        "max-jobs-per-rider",
        1,
        50000,
      );
    } else if (arg.startsWith("--checkpoint=")) {
      const value = arg.slice("--checkpoint=".length).trim();
      if (!value) throw new Error("checkpoint path cannot be empty.");
      options.checkpointPath = resolve(value);
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.resetCheckpoint && !options.apply) {
    throw new Error("--reset-checkpoint is permitted only together with --apply.");
  }
  return options;
}

function usage() {
  return [
    "Backfill private operational projections (dry-run by default).",
    "",
    "Required environment:",
    "  SAVRIVO_EXPECTED_PROJECT_ID=<exact Firebase project id>",
    "  SAVRIVO_DATABASE_URL=<exact Realtime Database URL>",
    "",
    "Apply additionally requires:",
    "  SAVRIVO_CONFIRM_PROJECT_ID=<same exact project id>",
    "",
    "Options:",
    "  --apply                         enable database/checkpoint writes",
    "  --page-size=100                 per-query page size (1..500)",
    "  --max-records=500               projections handled this run (1..10000)",
    "  --max-jobs-per-rider=5000       safety ceiling per rider",
    "  --checkpoint=<local path>       resumable apply checkpoint",
    "  --reset-checkpoint              restart apply from the beginning",
  ].join("\n");
}

function databaseFingerprint(databaseUrl) {
  return createHash("sha256").update(databaseUrl).digest("hex").slice(0, 16);
}

function initialCheckpoint(projectId, databaseUrl) {
  return {
    version: CHECKPOINT_VERSION,
    projectId,
    databaseFingerprint: databaseFingerprint(databaseUrl),
    phase: "orders",
    orders: {
      lastCompletedCustomerKey: null,
      currentCustomerKey: null,
      lastCompletedOrderKey: null,
    },
    riderJobs: {
      lastCompletedRiderKey: null,
    },
    totals: {
      orderProjectionsVisited: 0,
      riderWorkloadsVisited: 0,
      writesCommitted: 0,
      writesSkipped: 0,
      writesPlanned: 0,
      invalidRecords: 0,
    },
  };
}

function loadCheckpoint(path, projectId, databaseUrl, apply, resetCheckpoint) {
  const initial = initialCheckpoint(projectId, databaseUrl);
  if (!apply || resetCheckpoint || !existsSync(path)) return initial;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.version !== CHECKPOINT_VERSION || value?.projectId !== projectId ||
      value?.databaseFingerprint !== initial.databaseFingerprint) {
    throw new Error("Checkpoint target/version mismatch. Use the correct checkpoint or explicitly reset it.");
  }
  if (!["orders", "riderJobs", "complete"].includes(value.phase)) {
    throw new Error("Checkpoint phase is invalid.");
  }
  value.orders = {...initial.orders, ...(value.orders ?? {})};
  value.riderJobs = {...initial.riderJobs, ...(value.riderJobs ?? {})};
  value.totals = {...initial.totals, ...(value.totals ?? {})};
  return value;
}

function saveCheckpoint(path, state, apply) {
  if (!apply) return;
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
  renameSync(temporary, path);
}

function objectEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

/** Inclusive RTDB startAt is converted to an exclusive local cursor. */
export async function readBoundedPage(ref, afterKey, pageSize) {
  let query = ref.orderByKey();
  if (afterKey) query = query.startAt(afterKey);
  // startAt is inclusive. With a resume cursor, fetch the cursor plus one
  // complete page plus one look-ahead record so hasMore stays exact.
  const snapshot = await query.limitToFirst(pageSize + (afterKey ? 2 : 1)).get();
  let entries = objectEntries(snapshot.val());
  if (afterKey && entries[0]?.[0] === afterKey) entries = entries.slice(1);
  return {
    entries: entries.slice(0, pageSize),
    hasMore: entries.length > pageSize,
  };
}

function safeOrder(raw, customerKey, orderKey) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (String(raw.id ?? "") !== orderKey || String(raw.customerId ?? "") !== customerKey) return null;
  const statuses = new Set([
    "Order placed", "Accepted", "Preparing", "Ready for pickup", "Assigned",
    "Handed to rider", "Out for delivery", "Near you", "Arrived", "Delivered", "Cancelled",
  ]);
  if (!Array.isArray(raw.items) || !raw.restaurantId || !statuses.has(String(raw.status ?? ""))) return null;
  if (!Number.isFinite(Number(raw.total)) || !Number.isFinite(Number(raw.createdAt)) ||
      !Number.isFinite(Number(raw.updatedAt))) return null;
  try {
    return buildOperationalOrderProjection(raw);
  } catch {
    return null;
  }
}

function equivalent(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function persistOrderProjection(targetRef, next, apply, counters) {
  if (!apply) {
    const current = (await targetRef.get()).val();
    if (!equivalent(current, next) && shouldApplyOperationalOrderProjection(current, next)) {
      counters.writesPlanned += 1;
    }
    return;
  }
  const result = await targetRef.transaction((current) => {
    if (equivalent(current, next)) return undefined;
    return shouldApplyOperationalOrderProjection(current, next) ? next : undefined;
  }, undefined, false);
  if (result.committed) counters.writesCommitted += 1;
  else counters.writesSkipped += 1;
}

function sourceTimestamp(job) {
  const values = [job?.updatedAt, job?.completedAt, job?.assignedAt, job?.createdAt]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.trunc(Math.max(...values)) : 1;
}

async function readRiderJobs(riderRef, pageSize, maxJobsPerRider) {
  let cursor = null;
  const jobs = {};
  let jobCount = 0;
  let invalidJobs = 0;
  let maxSourceTimestamp = 1;
  while (true) {
    const page = await readBoundedPage(riderRef, cursor, pageSize);
    for (const [jobKey, raw] of page.entries) {
      if (jobCount >= maxJobsPerRider) {
        throw new Error("A rider exceeds --max-jobs-per-rider; no partial workload projection was written.");
      }
      cursor = jobKey;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        invalidJobs += 1;
        continue;
      }
      jobs[jobKey] = raw;
      jobCount += 1;
      maxSourceTimestamp = Math.max(maxSourceTimestamp, sourceTimestamp(raw));
    }
    if (!page.hasMore) break;
  }
  return {jobs, maxSourceTimestamp, invalidJobs};
}

async function persistRiderWorkload(targetRef, next, apply, counters) {
  if (!apply) {
    const current = (await targetRef.get()).val();
    if (!equivalent(current, next) && Number(current?.updatedAt ?? 0) < next.updatedAt) {
      counters.writesPlanned += 1;
    }
    return;
  }
  const result = await targetRef.transaction((current) => {
    if (equivalent(current, next)) return undefined;
    const currentUpdatedAt = Number(current?.updatedAt ?? 0);
    return currentUpdatedAt >= next.updatedAt ? undefined : next;
  }, undefined, false);
  if (result.committed) counters.writesCommitted += 1;
  else counters.writesSkipped += 1;
}

async function processOrders(database, state, options, budget) {
  const customerRef = database.ref(`${ROOT}/orders`);
  while (budget.remaining > 0 && state.phase === "orders") {
    const customerPage = state.orders.currentCustomerKey
      ? {entries: [[state.orders.currentCustomerKey, true]], hasMore: true}
      : await readBoundedPage(customerRef, state.orders.lastCompletedCustomerKey, options.pageSize);
    const customers = customerPage.entries;
    if (customers.length === 0) {
      state.phase = "riderJobs";
      saveCheckpoint(options.checkpointPath, state, options.apply);
      break;
    }

    for (const [customerKey] of customers) {
      if (budget.remaining <= 0) return;
      if (state.orders.currentCustomerKey !== customerKey) {
        state.orders.currentCustomerKey = customerKey;
        state.orders.lastCompletedOrderKey = null;
      }
      const orderRef = database.ref(`${ROOT}/orders/${customerKey}`);
      while (budget.remaining > 0) {
        const orderPage = await readBoundedPage(orderRef, state.orders.lastCompletedOrderKey, options.pageSize);
        if (orderPage.entries.length === 0) {
          state.orders.lastCompletedCustomerKey = customerKey;
          state.orders.currentCustomerKey = null;
          state.orders.lastCompletedOrderKey = null;
          saveCheckpoint(options.checkpointPath, state, options.apply);
          break;
        }
        for (const [orderKey, raw] of orderPage.entries) {
          if (budget.remaining <= 0) return;
          const next = safeOrder(raw, customerKey, orderKey);
          if (next) {
            await persistOrderProjection(
              database.ref(`${ROOT}/private/operations/orders/${orderKey}`),
              next,
              options.apply,
              state.totals,
            );
          } else {
            state.totals.invalidRecords += 1;
            if (options.apply) {
              throw new Error("An invalid canonical order blocked apply; repair it and resume from the unchanged checkpoint.");
            }
          }
          state.orders.lastCompletedOrderKey = orderKey;
          state.totals.orderProjectionsVisited += 1;
          budget.remaining -= 1;
          saveCheckpoint(options.checkpointPath, state, options.apply);
        }
        if (!orderPage.hasMore) {
          state.orders.lastCompletedCustomerKey = customerKey;
          state.orders.currentCustomerKey = null;
          state.orders.lastCompletedOrderKey = null;
          saveCheckpoint(options.checkpointPath, state, options.apply);
          break;
        }
      }
    }
  }
}

async function processRiderJobs(database, state, options, budget) {
  const ridersRef = database.ref(`${ROOT}/riderJobs`);
  while (budget.remaining > 0 && state.phase === "riderJobs") {
    const page = await readBoundedPage(ridersRef, state.riderJobs.lastCompletedRiderKey, options.pageSize);
    if (page.entries.length === 0) {
      state.phase = "complete";
      saveCheckpoint(options.checkpointPath, state, options.apply);
      break;
    }
    for (const [riderKey] of page.entries) {
      if (budget.remaining <= 0) return;
      const {jobs, maxSourceTimestamp, invalidJobs} = await readRiderJobs(
        database.ref(`${ROOT}/riderJobs/${riderKey}`),
        options.pageSize,
        options.maxJobsPerRider,
      );
      if (invalidJobs > 0) {
        state.totals.invalidRecords += invalidJobs;
        if (options.apply) {
          throw new Error("An invalid rider-job history blocked apply; repair it and resume from the unchanged checkpoint.");
        }
      }
      let next;
      try {
        next = buildRiderOperationalWorkload(riderKey, jobs, maxSourceTimestamp);
      } catch {
        state.totals.invalidRecords += 1;
        if (options.apply) {
          throw new Error("An invalid rider-job history blocked apply; repair it and resume from the unchanged checkpoint.");
        }
      }
      if (next) {
        await persistRiderWorkload(
          database.ref(`${ROOT}/private/operations/riderWorkload/${riderKey}`),
          next,
          options.apply,
          state.totals,
        );
      }
      state.riderJobs.lastCompletedRiderKey = riderKey;
      state.totals.riderWorkloadsVisited += 1;
      budget.remaining -= 1;
      saveCheckpoint(options.checkpointPath, state, options.apply);
    }
    if (!page.hasMore) {
      state.phase = "complete";
      saveCheckpoint(options.checkpointPath, state, options.apply);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const apply = options.apply === true;
  const expectedProjectId = String(process.env.SAVRIVO_EXPECTED_PROJECT_ID ?? "").trim();
  const confirmationProjectId = String(process.env.SAVRIVO_CONFIRM_PROJECT_ID ?? "").trim();
  const databaseUrl = String(process.env.SAVRIVO_DATABASE_URL ?? "").trim().replace(/\/$/u, "");
  if (!expectedProjectId) throw new Error("SAVRIVO_EXPECTED_PROJECT_ID is required.");
  if (!databaseUrl || !/^https:\/\/[^/]+(?:\.firebaseio\.com|\.firebasedatabase\.app)$/u.test(databaseUrl)) {
    throw new Error("SAVRIVO_DATABASE_URL must be the exact HTTPS Firebase Realtime Database root URL.");
  }
  const databaseHost = new URL(databaseUrl).hostname;
  const databaseInstance = databaseHost.split(".")[0];
  if (databaseInstance !== expectedProjectId && !databaseInstance.startsWith(`${expectedProjectId}-`)) {
    throw new Error("SAVRIVO_DATABASE_URL does not belong to SAVRIVO_EXPECTED_PROJECT_ID.");
  }
  if (apply && confirmationProjectId !== expectedProjectId) {
    throw new Error("Apply requires SAVRIVO_CONFIRM_PROJECT_ID to exactly match SAVRIVO_EXPECTED_PROJECT_ID.");
  }

  const state = loadCheckpoint(
    options.checkpointPath,
    expectedProjectId,
    databaseUrl,
    apply,
    options.resetCheckpoint,
  );
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: expectedProjectId,
    databaseURL: databaseUrl,
  }, `operational-projection-backfill-${Date.now()}`);
  const database = getDatabase(app);
  const budget = {remaining: options.maxRecords};
  const startedTotals = {...state.totals};

  try {
    console.log(`${apply ? "APPLY" : "DRY RUN"}: project=${expectedProjectId}, phase=${state.phase}, boundedRecords=${options.maxRecords}, pageSize=${options.pageSize}`);
    if (state.phase === "orders") await processOrders(database, state, options, budget);
    if (state.phase === "riderJobs" && budget.remaining > 0) await processRiderJobs(database, state, options, budget);
    console.log([
      `SUMMARY mode=${apply ? "apply" : "dry-run"}`,
      `phase=${state.phase}`,
      `ordersVisited=${state.totals.orderProjectionsVisited - startedTotals.orderProjectionsVisited}`,
      `riderWorkloadsVisited=${state.totals.riderWorkloadsVisited - startedTotals.riderWorkloadsVisited}`,
      `writesCommitted=${state.totals.writesCommitted - startedTotals.writesCommitted}`,
      `writesSkipped=${state.totals.writesSkipped - startedTotals.writesSkipped}`,
      `writesPlanned=${state.totals.writesPlanned - startedTotals.writesPlanned}`,
      `invalidRecords=${state.totals.invalidRecords - startedTotals.invalidRecords}`,
    ].join(" "));
    if (!apply) console.log("No database or checkpoint writes were performed. Review the dry run before applying.");
    else if (state.phase !== "complete") console.log("Run the same apply command again to resume from the protected local checkpoint.");
    else console.log("Backfill checkpoint is complete. Keep it with the release evidence until rollout verification finishes.");
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = String(error?.message ?? "");
    const code = message.includes("permission") || message.includes("PERMISSION")
      ? "PERMISSION_DENIED"
      : message.includes("credential") || message.includes("Credential")
        ? "CREDENTIALS_UNAVAILABLE"
        : message.includes("checkpoint") || message.includes("Checkpoint")
          ? "CHECKPOINT_INVALID"
          : message.includes("canonical order")
            ? "INVALID_CANONICAL_ORDER"
            : message.includes("rider-job") || message.includes("max-jobs-per-rider")
              ? "INVALID_OR_OVERSIZED_RIDER_HISTORY"
              : "OPERATION_FAILED";
    console.error(`BACKFILL_FAILED code=${code}`);
    process.exitCode = 1;
  });
}
