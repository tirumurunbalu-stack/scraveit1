#!/usr/bin/env node

import {createHash} from "node:crypto";
import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--apply") throw new Error(`Unknown argument: ${arg}`);
}

const apply = args.has("--apply");
const expectedProjectId = String(process.env.SAVRIVO_EXPECTED_PROJECT_ID ?? "").trim();
const confirmationProjectId = String(process.env.SAVRIVO_CONFIRM_PROJECT_ID ?? "").trim();

if (!expectedProjectId) throw new Error("SAVRIVO_EXPECTED_PROJECT_ID is required.");
if (apply && confirmationProjectId !== expectedProjectId) {
  throw new Error("Apply requires SAVRIVO_CONFIRM_PROJECT_ID to exactly match SAVRIVO_EXPECTED_PROJECT_ID.");
}

function parseUidList(name) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return [];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  for (const uid of values) {
    if (uid.includes("@")) throw new Error(`${name} accepts Firebase UIDs only; email-shaped values are refused.`);
    if (uid.length > 128 || /[\u0000-\u001f\u007f\s]/u.test(uid)) throw new Error(`${name} contains an invalid Firebase UID.`);
  }
  return [...new Set(values)];
}

const owners = parseUidList("SAVRIVO_OWNER_UIDS");
const operationsAdmins = parseUidList("SAVRIVO_OPS_ADMIN_UIDS");
if (owners.length + operationsAdmins.length === 0) {
  throw new Error("Provide at least one UID through SAVRIVO_OWNER_UIDS or SAVRIVO_OPS_ADMIN_UIDS.");
}

const overlap = owners.filter((uid) => operationsAdmins.includes(uid));
if (overlap.length > 0) throw new Error("A UID cannot be present in both role allowlists.");

const desired = new Map([
  ...owners.map((uid) => [uid, "owner"]),
  ...operationsAdmins.map((uid) => [uid, "ops_admin"]),
]);
const fingerprint = (uid) => createHash("sha256").update(uid).digest("hex").slice(0, 12);

const app = initializeApp({credential: applicationDefault(), projectId: expectedProjectId}, `admin-claims-${Date.now()}`);
const auth = getAuth(app);
let changed = 0;
let unchanged = 0;
let missing = 0;

try {
  console.log(`${apply ? "APPLY" : "DRY RUN"}: project=${expectedProjectId}, principals=${desired.size}`);
  const resolvedUsers = new Map();
  for (const [uid, desiredRole] of desired) {
    const principal = fingerprint(uid);
    let user;
    try {
      user = await auth.getUser(uid);
    } catch (error) {
      if (error?.code === "auth/user-not-found") {
        missing += 1;
        console.error(`MISSING principal=${principal}`);
        continue;
      }
      throw error;
    }

    resolvedUsers.set(uid, user);
  }

  let unexpectedAdmins = 0;
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      const existingRole = user.customClaims?.savrivoRole;
      if ((existingRole === "owner" || existingRole === "ops_admin") && !desired.has(user.uid)) {
        unexpectedAdmins += 1;
        console.error(`UNEXPECTED_ADMIN principal=${fingerprint(user.uid)} role=${existingRole}`);
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  if (missing > 0 || unexpectedAdmins > 0) {
    console.error(`PREFLIGHT_BLOCKED missing=${missing} unexpectedAdmins=${unexpectedAdmins}`);
    throw new Error("Custom-claims preflight failed; no claims were changed.");
  }

  for (const [uid, desiredRole] of desired) {
    const principal = fingerprint(uid);
    const user = resolvedUsers.get(uid);

    const currentClaims = user.customClaims ?? {};
    const currentRole = currentClaims.savrivoRole;
    if (currentRole === desiredRole) {
      unchanged += 1;
      console.log(`UNCHANGED principal=${principal} role=${desiredRole}`);
      continue;
    }

    changed += 1;
    console.log(`${apply ? "UPDATING" : "WOULD_UPDATE"} principal=${principal} role=${String(currentRole ?? "none")}->${desiredRole}`);
    if (!apply) continue;

    await auth.setCustomUserClaims(uid, {...currentClaims, savrivoRole: desiredRole});
    const verified = await auth.getUser(uid);
    if (verified.customClaims?.savrivoRole !== desiredRole) {
      throw new Error(`Claim verification failed for principal=${principal}.`);
    }
  }

  console.log(`SUMMARY mode=${apply ? "apply" : "dry-run"} changed=${changed} unchanged=${unchanged} missing=${missing}`);
  if (!apply && changed > 0) console.log("No claims were changed. Re-run with --apply and the matching confirmation project variable after review.");
  if (apply) console.log("Claims verified. Affected users must refresh their Firebase ID token before claims-gated rules are enabled.");
} finally {
  await deleteApp(app);
}
