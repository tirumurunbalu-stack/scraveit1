#!/usr/bin/env bash
# Saves the App Review demo login for one iOS app (App Store Connect API key).
# You type the values; the password is hidden and never printed or saved on disk.
# Usage: ios/tools/set_review_login.sh [customer|restaurant|delivery]   (default: customer)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
case "${1:-customer}" in
  customer) BUNDLE=in.scraveit.customer; LABEL="Scraveit customer app" ;;
  restaurant) BUNDLE=in.scraveit.restaurant; LABEL="Scraveit Restaurant app" ;;
  delivery) BUNDLE=in.scraveit.delivery; LABEL="Scraveit delivery partner app" ;;
  *) echo "Usage: $0 [customer|restaurant|delivery]"; exit 1 ;;
esac
echo "Demo login for the $LABEL"
read -r -p "Review account user name (email): " REVIEW_USER
read -r -s -p "Review account password: " REVIEW_PASS; echo
[[ -n "$REVIEW_USER" && -n "$REVIEW_PASS" ]] || { echo "Both are needed."; exit 1; }
BUNDLE="$BUNDLE" REVIEW_USER="$REVIEW_USER" REVIEW_PASS="$REVIEW_PASS" node --input-type=module -e '
import { asc } from "./asc.mjs";
const app = (await asc("GET", `/v1/apps?filter[bundleId]=${process.env.BUNDLE}`)).data[0];
const version = (await asc("GET", `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS`)).data
  .find(v => ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "WAITING_FOR_REVIEW"].includes(v.attributes.appStoreState));
if (!version) { console.log("No version to edit."); process.exit(1); }
const v = await asc("GET", `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`);
const id = v.data.id;
await asc("PATCH", `/v1/appStoreReviewDetails/${id}`, { data: { type: "appStoreReviewDetails", id, attributes: {
  demoAccountRequired: true, demoAccountName: process.env.REVIEW_USER, demoAccountPassword: process.env.REVIEW_PASS } } });
const after = (await asc("GET", `/v1/appStoreReviewDetails/${id}`)).data.attributes;
console.log(after.demoAccountName && after.demoAccountPassword ? "Saved. Tell Claude: saved" : "Not saved, try again");
'
