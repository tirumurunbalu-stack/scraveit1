#!/usr/bin/env node

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  countLegacyAdminBypasses,
  removeLegacyAdminBypasses,
} from "../tools/build-admin-claims-stage2.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const activePath = join(repositoryRoot, "firebase/feastly-realtime-database-rules.json");
const stage1Path = join(repositoryRoot, "firebase/feastly-realtime-database-rules.production-functions-stage1.json");
const stage2Path = join(repositoryRoot, "firebase/feastly-realtime-database-rules.admin-claims-stage2.json");
const defaultConfigPath = join(repositoryRoot, "firebase.json");
const stage2ConfigPath = join(repositoryRoot, "firebase/firebase.admin-claims-stage2.json");
const migrationScriptPath = join(repositoryRoot, "functions/scripts/migrate-admin-claims.mjs");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const activeText = readFileSync(activePath, "utf8");
const stage1Text = readFileSync(stage1Path, "utf8");
const stage2Text = readFileSync(stage2Path, "utf8");
const active = JSON.parse(activeText);
const stage1 = JSON.parse(stage1Text);
const stage2 = JSON.parse(stage2Text);
const defaultConfig = readJson(defaultConfigPath);
const stage2Config = readJson(stage2ConfigPath);

const bypassCount = countLegacyAdminBypasses(stage1);
assert.ok(bypassCount > 0, "Stage 1 must still contain the compatibility shortcuts this migration removes.");
assert.deepEqual(stage2, removeLegacyAdminBypasses(stage1), "Stage 2 may only remove the known compatibility shortcuts.");
assert.equal(countLegacyAdminBypasses(stage2), 0, "Stage 2 must contain no legacy admin shortcut.");
assert.doesNotMatch(stage2Text, /auth\.token\.email\s*===/, "Email must never authorize an administrator.");
assert.doesNotMatch(stage2Text, /auth\.uid\s*===\s*'[^']+'/, "A literal UID must never authorize an administrator.");
assert.match(stage2Text, /auth\.token\.savrivoRole === 'owner'/);
assert.match(stage2Text, /auth\.token\.savrivoRole === 'ops_admin'/);

assert.equal(
  defaultConfig.database?.rules,
  "firebase/feastly-realtime-database-rules.json",
  "Default deployment must continue to target the active-compatible rules.",
);
assert.deepEqual(Object.keys(stage2Config), ["database"], "Stage-2 config must deploy only Realtime Database rules.");
assert.equal(
  stage2Config.database?.rules,
  "feastly-realtime-database-rules.admin-claims-stage2.json",
  "The isolated config must target only the claims-gated staged rules.",
);
assert.deepEqual(active, JSON.parse(activeText), "Validation must not mutate active rules.");

const migrationScript = readFileSync(migrationScriptPath, "utf8");
assert.match(migrationScript, /--apply/);
assert.match(migrationScript, /SAVRIVO_OWNER_UIDS/);
assert.match(migrationScript, /SAVRIVO_OPS_ADMIN_UIDS/);
assert.match(migrationScript, /\.\.\.currentClaims/);
assert.match(migrationScript, /listUsers/, "Preflight must detect already-privileged accounts outside the explicit UID allowlist.");
assert.match(migrationScript, /UNEXPECTED_ADMIN/);
assert.doesNotMatch(migrationScript, /getUserByEmail|SAVRIVO_[A-Z_]*EMAIL/, "Migration authority must be an explicit UID list only.");
assert.doesNotMatch(migrationScript, /@[A-Za-z0-9.-]+/, "Migration source must not embed an email address.");

console.log(`Admin-claims stage 2 validated: ${bypassCount} legacy shortcuts removed; active rules and default deployment target unchanged.`);
