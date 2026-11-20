#!/usr/bin/env bash
# Saves the App Review demo login for the iOS Customer app (App Store Connect API key).
# You type the values; the password is hidden and never printed or saved on disk.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
read -r -p "Review account user name (email): " REVIEW_USER
read -r -s -p "Review account password: " REVIEW_PASS; echo
[[ -n "$REVIEW_USER" && -n "$REVIEW_PASS" ]] || { echo "Both are needed."; exit 1; }
REVIEW_USER="$REVIEW_USER" REVIEW_PASS="$REVIEW_PASS" node --input-type=module -e '
import { asc } from "./asc.mjs";
const v = await asc("GET", "/v1/appStoreVersions/5abf2427-4864-4f81-810c-441b1e6cc4ea/appStoreReviewDetail");
const id = v.data.id;
await asc("PATCH", `/v1/appStoreReviewDetails/${id}`, { data: { type: "appStoreReviewDetails", id, attributes: {
  demoAccountRequired: true, demoAccountName: process.env.REVIEW_USER, demoAccountPassword: process.env.REVIEW_PASS } } });
const after = (await asc("GET", `/v1/appStoreReviewDetails/${id}`)).data.attributes;
console.log(after.demoAccountName && after.demoAccountPassword ? "Saved. Tell Claude: saved" : "Not saved, try again");
'
