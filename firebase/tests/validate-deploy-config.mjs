#!/usr/bin/env node

// Checks the deployment config that firebase.json actually ships today.
//
// The stage-1..5 validators in this folder gated a staged Realtime Database
// rollout for the catalogue, orders and promotions. That data now lives in
// Firestore; the only Realtime Database still in use is the Singapore
// instance carrying live rider presence and tracking. Those validators are no
// longer part of tests/run.sh - this file covers what is deployed instead.

import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const pathFromRoot = (path) => join(repositoryRoot, path);
const readText = (path) => readFileSync(pathFromRoot(path), "utf8");
const readJson = (path) => JSON.parse(readText(path));

const config = readJson("firebase.json");

// Every rules/indexes file the deploy references must exist; a missing one
// fails `firebase deploy` only at release time.
assert.ok(Array.isArray(config.database), "firebase.json must list Realtime Database instances as targets.");
const referenced = [
  ...config.database.map((entry) => entry.rules),
  config.firestore?.rules,
  config.firestore?.indexes,
  config.storage?.rules,
];
for (const path of referenced) {
  assert.ok(path, "firebase.json has a rules/indexes entry with no path.");
  assert.ok(existsSync(pathFromRoot(path)), `firebase.json references a missing file: ${path}`);
}
for (const entry of config.database) {
  assert.ok(entry.target, `Realtime Database rules ${entry.rules} must name a deploy target.`);
  const rules = readJson(entry.rules).rules;
  assert.equal(rules[".read"], false, `${entry.target}: no root read grant may bypass child rules.`);
  assert.equal(rules[".write"], false, `${entry.target}: no root write grant may bypass child rules.`);
  assert.equal(rules.feastly?.[".read"], false, `${entry.target}: no /feastly read grant may bypass child rules.`);
  assert.equal(rules.feastly?.[".write"], false, `${entry.target}: no /feastly write grant may bypass child rules.`);
}

// The live-tracking instance the Functions talk to must be one of the
// deployed targets, and its rules must cover every path the Functions touch.
const singapore = config.database.find((entry) => entry.target === "singapore");
assert.ok(singapore, "The Singapore live-tracking Realtime Database must be a deploy target.");
assert.match(
  readText("functions/src/admin.ts"),
  /getDatabaseWithUrl\("https:\/\/savrivo-app-sg\.asia-southeast1\.firebasedatabase\.app"\)/,
  "Functions must write live tracking to the Singapore instance.",
);
const singaporeFeastly = readJson(singapore.rules).rules.feastly;
for (const node of ["riderPresence", "tracking", "trackingAssignments", "trackingViewers"]) {
  assert.ok(singaporeFeastly[node], `Singapore rules must declare /feastly/${node}, which Functions write.`);
}

// Firestore index file must parse and every composite index must name a
// collection and at least two fields (single-field indexes are automatic).
const indexes = readJson(config.firestore.indexes);
assert.ok(Array.isArray(indexes.indexes) && indexes.indexes.length > 0, "Firestore indexes must be listed.");
for (const index of indexes.indexes) {
  assert.ok(index.collectionGroup, "Every Firestore index needs a collectionGroup.");
  assert.ok(Array.isArray(index.fields) && index.fields.length >= 2,
    `Composite index on ${index.collectionGroup} needs at least two fields.`);
}

const firestoreRules = readText(config.firestore.rules);
assert.match(firestoreRules, /^\s*rules_version\s*=\s*'2';/m, "Firestore rules must use rules_version 2.");
assert.match(firestoreRules, /service cloud\.firestore/, "Firestore rules must declare the cloud.firestore service.");
assert.doesNotMatch(firestoreRules, /allow\s+read\s*,\s*write\s*:\s*if\s+true\s*;/,
  "Firestore rules must not grant open read/write.");

console.log(`Firebase deploy config validated: ${config.database.length} Realtime Database targets, ${indexes.indexes.length} Firestore indexes.`);
