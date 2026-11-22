#!/usr/bin/env bash
# Checks that the App Review demo login saved in App Store Connect can really
# sign in to Scraveit. Prints only "works" or "wrong"; the password is never shown.
# Usage: ios/tools/check_review_login.sh [restaurant|delivery|customer]   (default: restaurant)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
case "${1:-restaurant}" in
  customer) BUNDLE=in.scraveit.customer; CONFIG=app ;;
  restaurant) BUNDLE=in.scraveit.restaurant; CONFIG=restaurant ;;
  delivery) BUNDLE=in.scraveit.delivery; CONFIG=rider ;;
  *) echo "Usage: $0 [restaurant|delivery|customer]"; exit 1 ;;
esac
BUNDLE="$BUNDLE" CONFIG_FILE="../../native_android/$CONFIG/src/main/assets/firebase-config.js" node --input-type=module -e '
import fs from "node:fs";
import { asc } from "./asc.mjs";
const key = (fs.readFileSync(process.env.CONFIG_FILE, "utf8").match(/apiKey\s*:\s*["\x27]([^"\x27]+)/) || [])[1];
if (!key) { console.log("Could not read the app settings."); process.exit(1); }
const app = (await asc("GET", `/v1/apps?filter[bundleId]=${process.env.BUNDLE}`)).data[0];
const version = (await asc("GET", `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS`)).data
  .find(v => ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "WAITING_FOR_REVIEW", "IN_REVIEW"].includes(v.attributes.appStoreState));
if (!version) { console.log("No version found."); process.exit(1); }
const d = (await asc("GET", `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)).data.attributes;
if (!d.demoAccountName || !d.demoAccountPassword) { console.log("No demo login saved yet."); process.exit(1); }
const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: d.demoAccountName, password: d.demoAccountPassword, returnSecureToken: false }) });
const body = await r.json().catch(() => ({}));
const why = String(body.error?.message || r.status);
if (r.ok) console.log(`works: Apple can sign in as ${d.demoAccountName}`);
else if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|USER_DISABLED/.test(why)) console.log(`wrong: ${d.demoAccountName} did not sign in (${why})`);
else console.log(`could not check (${why})`);
'
