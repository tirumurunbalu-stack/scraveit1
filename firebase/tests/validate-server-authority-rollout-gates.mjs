#!/usr/bin/env node

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const pathFromRoot = (path) => join(repositoryRoot, path);
const readJson = (path) => JSON.parse(readFileSync(pathFromRoot(path), "utf8"));
const readText = (path) => readFileSync(pathFromRoot(path), "utf8");

const gates = readJson("firebase/server-authority-stage4-rollout-gates.json");
const defaultConfig = readJson("firebase.json");
const isolatedConfig = readJson("firebase/firebase.server-authority-stage4.json");

assert.equal(gates.rulesArtifact, "feastly-realtime-database-rules.server-authority-stage4.json");
assert.equal(gates.derivedFrom, "feastly-realtime-database-rules.query-indexes-stage3.json");
assert.equal(gates.deploymentConfig, "firebase.server-authority-stage4.json");
assert.equal(defaultConfig.database?.rules, "firebase/feastly-realtime-database-rules.json");
assert.equal(isolatedConfig.database?.rules, gates.rulesArtifact);

const applications = {
  customer: "native_android/app/build.gradle",
  restaurant: "native_android/restaurant/build.gradle",
  rider: "native_android/rider/build.gradle",
  admin: "native_android/admin/build.gradle",
};

function parseGradleIdentity(path) {
  const source = readText(path);
  const applicationId = source.match(/applicationId\s+["']([^"']+)["']/)?.[1];
  const versionCode = Number(source.match(/versionCode\s+(\d+)/)?.[1]);
  const versionName = source.match(/versionName\s+["']([^"']+)["']/)?.[1];
  assert.ok(applicationId && Number.isInteger(versionCode) && versionName, `Could not parse Android identity from ${path}.`);
  return {applicationId, versionCode, versionName};
}

for (const [application, path] of Object.entries(applications)) {
  const actual = parseGradleIdentity(path);
  const floor = gates.sourceCompatibilityFloor[application];
  assert.equal(actual.applicationId, floor.applicationId, `${application} package identity changed.`);
  assert.ok(actual.versionCode >= floor.minimumVersionCode, `${application} is below the callable source-compatibility floor.`);
  assert.ok(actual.versionName.length > 0 && floor.minimumVersionName.length > 0,
    `${application} source and audited floor must both record a version name.`);
  assert.ok(
    gates.fullCompatibilityFloor[application].minimumVersionCode >= floor.minimumVersionCode,
    `${application} full-compatibility floor cannot precede its source floor.`,
  );
}

assert.ok(
  gates.fullCompatibilityFloor.customer.minimumVersionCode >= gates.sourceCompatibilityFloor.customer.minimumVersionCode,
  "Customer full-compatibility floor cannot precede its source floor.",
);

const gateById = Object.fromEntries(gates.requiredPredeployGates.map((gate) => [gate.id, gate]));
for (const requiredId of [
  "production_backup_and_rollback",
  "callable_backend_verified",
  "app_check_production_ready",
  "admin_claims_provisioned",
  "minimum_clients_adopted",
  "review_money_rail_resolved",
  "emulator_and_canary_passed",
]) {
  assert.ok(gateById[requiredId], `Missing rollout gate: ${requiredId}`);
}
assert.equal(gateById.review_money_rail_resolved.status, "source_resolved");
assert.ok(gates.requiredPredeployGates.every((gate) => gate.status !== "complete"), "External rollout gates must not be pre-certified by a source-only audit.");

console.log("Server-authority stage-4 rollout gates validated: exact client floors recorded and production rollout remains explicitly blocked pending external verification.");
