#!/usr/bin/env node

/**
 * One-off load test against the live savrivo-app Realtime Database, scoped
 * strictly to what a real user session actually does before any order is
 * placed: the bounded catalog read query (restaurantSummaryQuery() in
 * native_android/app/src/main/assets/premium.js) and its realtime-watcher
 * connection (watchPath()/ensureRealtimeWatcher() in the same file).
 *
 * This is the resource this session's architecture review identified as the
 * real ceiling - a single us-central1 RTDB instance with a documented
 * ~200,000 concurrent connection cap and a soft ~1,000 writes/sec ceiling -
 * so it is what a capacity number should actually measure.
 *
 * Deliberately does NOT touch createOrder/createCodOrder or any other
 * onCall function: those enforce App Check, which a script cannot pass
 * without a registered debug token, and exercising them at load would write
 * real records that need cleanup. This script writes nothing to the
 * database at all - only disposable Firebase Auth test accounts, deleted at
 * the end of the run.
 *
 * Usage: node loadtest/run.mjs [--read-max=10000] [--connection-max=5000]
 *
 * Node's built-in fetch() defaults to a small per-origin connection pool
 * (undici's default Agent), which is what actually produced the "fetch
 * failed" errors in the first run at 1000/500 concurrency - not the
 * database. A dedicated Agent with a much larger pool, set as the global
 * dispatcher, removes that artificial ceiling so the ramp measures the
 * database and this machine's real network capacity instead.
 */

import {Agent, setGlobalDispatcher} from "undici";

setGlobalDispatcher(new Agent({
  connections: 20000,
  pipelining: 0,
  keepAliveTimeout: 10000,
  keepAliveMaxTimeout: 10000,
  connect: {timeout: 15000},
}));

const API_KEY = process.env.LOADTEST_API_KEY || "AIzaSyBV3xmCm7HiWJLygloPDNBg6qq6gkO-F6I";
const DATABASE_URL = process.env.LOADTEST_DATABASE_URL || "https://savrivo-app-default-rtdb.firebaseio.com";
const PROJECT_ID = process.env.LOADTEST_PROJECT_ID || "savrivo-app";
const POOL_SIZE = 10;
const CONNECTION_HOLD_MS = 8000;
const READ_TIMEOUT_MS = 15000;
const ERROR_RATE_STOP = 0.1;

function parseArgs(argv) {
  const options = {
    readLevels: [10, 50, 100, 250, 500, 1000, 2000, 3500, 5000, 7500, 10000],
    connectionLevels: [10, 50, 100, 250, 500, 1000, 2000, 3500, 5000],
  };
  for (const arg of argv) {
    if (arg.startsWith("--read-max=")) {
      const max = Number(arg.slice("--read-max=".length));
      options.readLevels = options.readLevels.filter((level) => level <= max);
    } else if (arg.startsWith("--connection-max=")) {
      const max = Number(arg.slice("--connection-max=".length));
      options.connectionLevels = options.connectionLevels.filter((level) => level <= max);
    }
  }
  return options;
}

async function signUpTestUser(index) {
  const email = `loadtest-${Date.now()}-${index}@example.com`;
  const password = "LoadTest!" + Math.random().toString(36).slice(2, 10);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({email, password, returnSecureToken: true}),
  });
  if (!res.ok) throw new Error(`signUp failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {email, idToken: data.idToken, localId: data.localId};
}

async function deleteTestUser(user) {
  try {
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({idToken: user.idToken}),
    });
  } catch { /* best-effort cleanup */ }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function catalogUrl(token) {
  const orderBy = encodeURIComponent('"$key"');
  return `${DATABASE_URL}/feastly/catalog/restaurants.json?auth=${encodeURIComponent(token)}&orderBy=${orderBy}&limitToFirst=40`;
}

async function timedReadQuery(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(catalogUrl(token), {signal: controller.signal});
    await res.arrayBuffer();
    return {ok: res.ok, ms: Date.now() - started, status: res.status};
  } catch (error) {
    return {ok: false, ms: Date.now() - started, status: 0, error: String(error && error.message || error)};
  } finally {
    clearTimeout(timer);
  }
}

async function runReadWave(tokens, concurrency) {
  const tasks = [];
  for (let i = 0; i < concurrency; i++) tasks.push(timedReadQuery(tokens[i % tokens.length]));
  const waveStarted = Date.now();
  const results = await Promise.all(tasks);
  const waveMs = Date.now() - waveStarted;
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
  return {
    concurrency, waveMs, ok: ok.length, failed: failed.length,
    p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99),
    max: latencies.length ? latencies[latencies.length - 1] : 0,
    sampleErrors: [...new Set(failed.slice(0, 5).map((r) => `${r.status} ${r.error || ""}`.trim()))],
  };
}

async function timedConnection(token) {
  const url = catalogUrl(token);
  const controller = new AbortController();
  const started = Date.now();
  try {
    const res = await fetch(url, {headers: {Accept: "text/event-stream"}, signal: controller.signal});
    if (!res.ok || !res.body) {
      controller.abort();
      return {ok: false, ms: Date.now() - started, status: res.status};
    }
    const reader = res.body.getReader();
    await reader.read(); // first chunk = the initial "put" snapshot Firebase always sends on connect
    const ms = Date.now() - started;
    setTimeout(() => { try { controller.abort(); } catch { /* already closed */ } }, Math.max(0, CONNECTION_HOLD_MS - ms));
    return {ok: true, ms, status: res.status};
  } catch (error) {
    return {ok: false, ms: Date.now() - started, status: 0, error: String(error && error.message || error)};
  }
}

async function runConnectionWave(tokens, concurrency) {
  const tasks = [];
  for (let i = 0; i < concurrency; i++) tasks.push(timedConnection(tokens[i % tokens.length]));
  const results = await Promise.all(tasks);
  await new Promise((resolve) => setTimeout(resolve, CONNECTION_HOLD_MS + 500));
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
  return {
    concurrency, ok: ok.length, failed: failed.length,
    p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95),
    max: latencies.length ? latencies[latencies.length - 1] : 0,
    sampleErrors: [...new Set(failed.slice(0, 5).map((r) => `${r.status} ${r.error || ""}`.trim()))],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Load test target: project=${PROJECT_ID} db=${DATABASE_URL}`);
  console.log(`Creating ${POOL_SIZE} disposable test accounts...`);
  const users = [];
  for (let i = 0; i < POOL_SIZE; i++) users.push(await signUpTestUser(i));
  const tokens = users.map((u) => u.idToken);
  console.log(`${users.length} test accounts ready.\n`);

  try {
    console.log("=== Bounded catalog read-query throughput (the app's real page-query shape) ===");
    for (const level of options.readLevels) {
      const result = await runReadWave(tokens, level);
      console.log(
        `concurrency=${result.concurrency} ok=${result.ok} failed=${result.failed} waveMs=${result.waveMs} `
        + `p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms max=${result.max}ms`
        + (result.sampleErrors.length ? ` errors=[${result.sampleErrors.join(", ")}]` : ""),
      );
      if (result.failed > result.concurrency * ERROR_RATE_STOP) {
        console.log(`Error rate exceeded ${ERROR_RATE_STOP * 100}% - stopping the read ramp here.`);
        break;
      }
    }

    console.log("\n=== Realtime watcher connection capacity (same path the app's EventSource watches) ===");
    for (const level of options.connectionLevels) {
      const result = await runConnectionWave(tokens, level);
      console.log(
        `concurrency=${result.concurrency} connected=${result.ok} failed=${result.failed} `
        + `p50=${result.p50}ms p95=${result.p95}ms max=${result.max}ms`
        + (result.sampleErrors.length ? ` errors=[${result.sampleErrors.join(", ")}]` : ""),
      );
      if (result.failed > result.concurrency * ERROR_RATE_STOP) {
        console.log(`Error rate exceeded ${ERROR_RATE_STOP * 100}% - stopping the connection ramp here.`);
        break;
      }
    }
  } finally {
    console.log("\nCleaning up disposable test accounts...");
    await Promise.all(users.map(deleteTestUser));
    console.log("Done.");
  }
}

main().catch((error) => {
  console.error("LOAD_TEST_FAILED", error);
  process.exitCode = 1;
});
