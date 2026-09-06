#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${SAVRIVO_FIREBASE_PROJECT:-savrivo-app}"
DEPLOY=0

if [[ "${1:-}" == "--deploy" ]]; then
  DEPLOY=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: ./BUILD_ON_MAC.sh [--deploy]" >&2
  exit 2
fi

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }
command -v firebase >/dev/null 2>&1 || { echo "firebase CLI is required (npm install -g firebase-tools)" >&2; exit 2; }

cd "$ROOT/native_android"
./tests/run.sh
python3 -m json.tool ../firebase/feastly-realtime-database-rules.json >/dev/null
echo "✓ Firebase rules JSON is valid"

cd "$ROOT"
firebase deploy --only database --project "$PROJECT" --dry-run

if [[ "$DEPLOY" -eq 1 ]]; then
  firebase deploy --only database --project "$PROJECT"
else
  echo
  echo "Database rules were NOT deployed. Re-run with --deploy after reviewing the dry run."
fi

cd "$ROOT/native_android"
./build_savrivo.sh --skip-tests

echo
printf '%s\n' \
  "APKs:" \
  "$ROOT/native_android/build/savrivo_developer/Savrivo-Customer-developer.apk" \
  "$ROOT/native_android/build/savrivo_developer/Savrivo-Admin-developer.apk" \
  "$ROOT/native_android/build/savrivo_developer/Savrivo-Restaurant-developer.apk" \
  "$ROOT/native_android/build/savrivo_developer/Savrivo-Partner-developer.apk"
