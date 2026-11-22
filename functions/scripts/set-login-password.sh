#!/usr/bin/env bash
# Sets a new Scraveit sign-in password for one account (Firebase Auth).
# You type the new password; it is hidden and never printed or saved on disk.
# Usage: functions/scripts/set-login-password.sh <email>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
EMAIL="${1:-}"
[[ -n "$EMAIL" ]] || { echo "Usage: $0 <email>"; exit 1; }
echo "New Scraveit sign-in password for $EMAIL"
read -r -s -p "New password (at least 8 characters): " P1; echo
read -r -s -p "Type it again: " P2; echo
[[ "$P1" == "$P2" ]] || { echo "The two passwords are different. Nothing changed."; exit 1; }
[[ ${#P1} -ge 8 ]] || { echo "Too short. Nothing changed."; exit 1; }
EMAIL="$EMAIL" NEW_PASSWORD="$P1" node --input-type=module -e '
import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
const app = initializeApp({credential: applicationDefault(), projectId: "savrivo-app"});
try {
  const auth = getAuth(app);
  const user = await auth.getUserByEmail(process.env.EMAIL);
  await auth.updateUser(user.uid, {password: process.env.NEW_PASSWORD});
  console.log("Password changed. Tell Claude: changed");
} catch (error) {
  console.log("Not changed:", error.code || error.message);
  process.exitCode = 1;
} finally {
  await deleteApp(app);
}'
