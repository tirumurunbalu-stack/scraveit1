#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${SAVRIVO_STAGING_OUTPUT_DIR:-$SCRIPT_DIR/build/savrivo_staging_sandbox}"
SKIP_TESTS=0
STAGING_PROJECT_ID="${SCRAVEIT_STAGING_PROJECT_ID:-savrivo-app}"

usage() {
  cat <<'USAGE'
Usage: native_android/build_staging_sandbox.sh [--output DIR] [--skip-tests]

Builds the four current debug APKs against the committed staging Firebase
configuration. This path is intended for dedicated staging devices only.

Options:
  --output DIR          Copy final artifacts to DIR.
  --skip-tests          Skip the JavaScript/native validation gate.

Environment variables:
  SCRAVEIT_STAGING_PROJECT_ID  Expected Firebase project ID. Defaults to savrivo-app.
  ANDROID_SDK_ROOT             Android SDK root (ANDROID_HOME is also accepted).
  JAVA_HOME                    JDK 17-25. Android Studio's bundled JDK is auto-detected.
  SAVRIVO_STAGING_OUTPUT_DIR   Default artifact output directory.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || { echo "--output requires a directory" >&2; exit 2; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$SKIP_TESTS" -eq 0 ]]; then
  "$SCRIPT_DIR/tests/run.sh"
fi

SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$SDK_ROOT" && -d "$HOME/Library/Android/sdk" ]]; then
  SDK_ROOT="$HOME/Library/Android/sdk"
fi
[[ -d "$SDK_ROOT" ]] || {
  echo "Android SDK not found. Install it with Android Studio or set ANDROID_SDK_ROOT." >&2
  exit 2
}

java_major() {
  local java_bin="$1" version
  version="$("$java_bin" -version 2>&1 | sed -n '1s/.*version "\([0-9][0-9]*\).*/\1/p')"
  [[ "$version" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$version"
}

select_java_home() {
  local candidates=() candidate major
  if [[ -n "${JAVA_HOME:-}" ]]; then candidates+=("$JAVA_HOME"); fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    while IFS= read -r candidate; do candidates+=("$candidate"); done < <(
      /usr/libexec/java_home -V 2>&1 \
        | sed -n 's/.* \(\/.*\/Contents\/Home\)$/\1/p' \
        | awk '!seen[$0]++'
    )
    candidates+=("/Applications/Android Studio.app/Contents/jbr/Contents/Home")
  fi
  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate/bin/java" ]] || continue
    major="$(java_major "$candidate/bin/java" || true)"
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 17 && major <= 25 )); then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

SELECTED_JAVA_HOME="$(select_java_home || true)"
[[ -n "$SELECTED_JAVA_HOME" ]] || {
  echo "Scraveit's pinned Android build requires JDK 17-25." >&2
  echo "Install JDK 17, or open the project in Android Studio and use its bundled JDK." >&2
  exit 2
}

export JAVA_HOME="$SELECTED_JAVA_HOME"
export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

node "$SCRIPT_DIR/tools/verify_staging_firebase.mjs" "$STAGING_PROJECT_ID"

"$SCRIPT_DIR/gradlew" --project-dir "$SCRIPT_DIR" --no-daemon \
  -PscraveitStagingProjectId="$STAGING_PROJECT_ID" \
  assembleStagingSandbox

copy_artifact() {
  local source="$1" name="$2"
  [[ -f "$source" ]] || { echo "Expected build artifact is missing: $source" >&2; exit 1; }
  cp -f "$source" "$OUTPUT_DIR/$name"
  echo "  Created $OUTPUT_DIR/$name"
}

echo "Scraveit staging sandbox APKs:"
copy_artifact "$SCRIPT_DIR/app/build/outputs/apk/debug/customer-debug.apk" "Scraveit-Customer-STAGING-SANDBOX-debug.apk"
copy_artifact "$SCRIPT_DIR/restaurant/build/outputs/apk/debug/restaurant-debug.apk" "Scraveit-Restaurant-STAGING-SANDBOX-debug.apk"
copy_artifact "$SCRIPT_DIR/rider/build/outputs/apk/debug/rider-debug.apk" "Scraveit-Rider-STAGING-SANDBOX-debug.apk"
copy_artifact "$SCRIPT_DIR/admin/build/outputs/apk/debug/admin-debug.apk" "Scraveit-Admin-STAGING-SANDBOX-debug.apk"

echo "Build completed. Output: $OUTPUT_DIR"
