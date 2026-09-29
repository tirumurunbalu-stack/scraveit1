#!/usr/bin/env node
/**
 * Read-only load test for the current backend (Cloud Firestore, asia-south1).
 *
 * Each simulated customer does what the app does before ordering: list the
 * restaurants, then open one restaurant's menu. Levels ramp up until the
 * error rate passes 5% or the top level is reached. Writes nothing and needs
 * no sign-in (the catalog is public). Order placement is not tested: it is
 * App Check protected and would create real records.
 *
 * Cost: about 20-40 document reads per simulated customer. The full ramp is
 * well under ₹20 of Firestore reads.
 *
 * Usage: node loadtest/firestore.mjs [--max=5000]
 */
import {Agent, setGlobalDispatcher} from "undici";

setGlobalDispatcher(new Agent({connections: 20000, pipelining: 0, connect: {timeout: 15000}}));

const API_KEY = "AIzaSyBV3xmCm7HiWJLygloPDNBg6qq6gkO-F6I";
const BASE = "https://firestore.googleapis.com/v1/projects/savrivo-app/databases/(default)/documents";
const TIMEOUT_MS = 15000;
const maxArg = process.argv.find((arg) => arg.startsWith("--max="));
const MAX = maxArg ? Number(maxArg.slice(6)) : 5000;
const LEVELS = [10, 50, 100, 250, 500, 1000, 2000, 3500, 5000, 7500, 10000].filter((level) => level <= MAX);

async function timed(url) {
  const started = performance.now();
  const response = await fetch(url, {signal: AbortSignal.timeout(TIMEOUT_MS)});
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${body?.error?.status ?? ""}`);
  return {ms: performance.now() - started, body};
}

async function customer(restaurantIds) {
  const list = await timed(`${BASE}/restaurants?pageSize=20&key=${API_KEY}`);
  const id = restaurantIds[Math.floor(Math.random() * restaurantIds.length)];
  const menu = await timed(`${BASE}/menus/${encodeURIComponent(id)}/items?pageSize=50&key=${API_KEY}`);
  return list.ms + menu.ms;
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

const seed = await timed(`${BASE}/restaurants?pageSize=50&key=${API_KEY}`);
const restaurantIds = (seed.body.documents ?? []).map((doc) => doc.name.split("/").pop());
if (!restaurantIds.length) throw new Error("No restaurants to read");
console.log(`Catalog: ${restaurantIds.length} restaurants. Levels: ${LEVELS.join(", ")}\n`);
console.log("customers at once | ok    | errors | median  | p95     | slowest | wall");

const results = [];
for (const level of LEVELS) {
  const started = performance.now();
  const outcomes = await Promise.allSettled(Array.from({length: level}, () => customer(restaurantIds)));
  const wall = performance.now() - started;
  const times = outcomes.filter((o) => o.status === "fulfilled").map((o) => o.value).sort((a, b) => a - b);
  const errors = outcomes.filter((o) => o.status === "rejected");
  const errorKinds = {};
  for (const e of errors) { const k = String(e.reason?.message ?? e.reason).slice(0, 40); errorKinds[k] = (errorKinds[k] ?? 0) + 1; }
  const row = {level, ok: times.length, errors: errors.length, p50: pct(times, 0.5), p95: pct(times, 0.95), max: times.at(-1) ?? 0, wall};
  results.push(row);
  const f = (ms) => `${(ms / 1000).toFixed(2)}s`.padEnd(7);
  console.log(`${String(level).padEnd(17)} | ${String(row.ok).padEnd(5)} | ${String(row.errors).padEnd(6)} | ${f(row.p50)} | ${f(row.p95)} | ${f(row.max)} | ${f(wall)}${errors.length ? "  " + JSON.stringify(errorKinds) : ""}`);
  if (errors.length / level > 0.05) { console.log("\nStopped: more than 5% errors."); break; }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
