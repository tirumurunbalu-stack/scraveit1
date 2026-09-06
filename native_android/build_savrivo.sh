#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${SAVRIVO_OUTPUT_DIR:-$SCRIPT_DIR/build/savrivo_developer}"
SKIP_TESTS=0
BUILD_RELEASE_BUNDLES=0

usage() {
  cat <<'USAGE'
Usage: native_android/build_savrivo.sh [--output DIR] [--skip-tests] [--release-bundles]

Builds Gradle debug APKs for all four Savrivo Android applications:
  - Customer
  - Partner
  - Restaurant
  - Admin

Options:
  --output DIR          Copy final artifacts to DIR.
  --skip-tests          Skip the JavaScript validation gate.
  --release-bundles     Also build optimized, unsigned release AABs.

Environment variables:
  ANDROID_SDK_ROOT      Android SDK root (ANDROID_HOME is also accepted).
  JAVA_HOME             JDK 17-25. Android Studio's bundled JDK is auto-detected.
  SAVRIVO_OUTPUT_DIR    Default artifact output directory.

Release AABs are intentionally unsigned. Google Play release signing must use a
separately protected upload key or Play App Signing; this script never reads a
keystore password and never uses the legacy developer keystore.
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
    --release-bundles)
      BUILD_RELEASE_BUNDLES=1
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
  echo "Savrivo's pinned Android build requires JDK 17-25." >&2
  echo "Install JDK 17, or open the project in Android Studio and use its bundled JDK." >&2
  exit 2
}

export JAVA_HOME="$SELECTED_JAVA_HOME"
export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

GRADLE_TASKS=(
  :customer:assembleDebug
  :rider:assembleDebug
  :restaurant:assembleDebug
  :admin:assembleDebug
)
if [[ "$BUILD_RELEASE_BUNDLES" -eq 1 ]]; then
  GRADLE_TASKS+=(verifyProduction)
fi

"$SCRIPT_DIR/gradlew" --project-dir "$SCRIPT_DIR" --no-daemon "${GRADLE_TASKS[@]}"

copy_artifact() {
  local source="$1" name="$2"
  [[ -f "$source" ]] || { echo "Expected build artifact is missing: $source" >&2; exit 1; }
  cp -f "$source" "$OUTPUT_DIR/$name"
  echo "  Created $OUTPUT_DIR/$name"
}

echo "Savrivo debug APKs:"
copy_artifact "$SCRIPT_DIR/app/build/outputs/apk/debug/customer-debug.apk" "Savrivo-Customer-debug.apk"
copy_artifact "$SCRIPT_DIR/rider/build/outputs/apk/debug/rider-debug.apk" "Savrivo-Partner-debug.apk"
copy_artifact "$SCRIPT_DIR/restaurant/build/outputs/apk/debug/restaurant-debug.apk" "Savrivo-Restaurant-debug.apk"
copy_artifact "$SCRIPT_DIR/admin/build/outputs/apk/debug/admin-debug.apk" "Savrivo-Admin-debug.apk"

if [[ "$BUILD_RELEASE_BUNDLES" -eq 1 ]]; then
  echo "Savrivo unsigned release App Bundles:"
  copy_artifact "$SCRIPT_DIR/app/build/outputs/bundle/release/customer-release.aab" "Savrivo-Customer-release-unsigned.aab"
  copy_artifact "$SCRIPT_DIR/rider/build/outputs/bundle/release/rider-release.aab" "Savrivo-Partner-release-unsigned.aab"
  copy_artifact "$SCRIPT_DIR/restaurant/build/outputs/bundle/release/restaurant-release.aab" "Savrivo-Restaurant-release-unsigned.aab"
  copy_artifact "$SCRIPT_DIR/admin/build/outputs/bundle/release/admin-release.aab" "Savrivo-Admin-release-unsigned.aab"
fi

echo "Build completed. Output: $OUTPUT_DIR"
