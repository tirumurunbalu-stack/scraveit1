#!/usr/bin/env node

import {readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const firebaseDirectory = resolve(toolDirectory, "..");

export const stage1Path = join(firebaseDirectory, "feastly-realtime-database-rules.production-functions-stage1.json");
export const stage2Path = join(firebaseDirectory, "feastly-realtime-database-rules.admin-claims-stage2.json");

// This deliberately matches the legacy admin shortcut as a structural rule
// expression. No production UID or email address is copied into this tool.
const LEGACY_ADMIN_BYPASS = / \|\| \(auth\.uid === '[^']+'(?: \|\| auth\.uid === '[^']+')*(?: \|\| auth\.token\.email === '[^']+')+\)/g;

export function removeLegacyAdminBypasses(value) {
  if (typeof value === "string") return value.replace(LEGACY_ADMIN_BYPASS, "");
  if (Array.isArray(value)) return value.map(removeLegacyAdminBypasses);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, removeLegacyAdminBypasses(child)]));
  }
  return value;
}

export function countLegacyAdminBypasses(value) {
  if (typeof value === "string") return value.match(LEGACY_ADMIN_BYPASS)?.length ?? 0;
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + countLegacyAdminBypasses(child), 0);
  if (value && typeof value === "object") {
    return Object.values(value).reduce((sum, child) => sum + countLegacyAdminBypasses(child), 0);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage1 = JSON.parse(readFileSync(stage1Path, "utf8"));
  const bypassCount = countLegacyAdminBypasses(stage1);
  if (bypassCount === 0) throw new Error("No legacy admin bypasses found; refusing to generate an unreviewed stage-2 artifact.");

  const stage2 = removeLegacyAdminBypasses(stage1);
  const serialized = `${JSON.stringify(stage2, null, 2)}\n`;
  if (/auth\.token\.email\s*===/.test(serialized) || /auth\.uid\s*===\s*'[^']+'/.test(serialized)) {
    throw new Error("Generated rules still contain a literal email or UID authorization shortcut.");
  }

  writeFileSync(stage2Path, serialized, {encoding: "utf8", mode: 0o644});
  console.log(`Generated admin-claims stage 2 with ${bypassCount} legacy authorization shortcuts removed.`);
}
