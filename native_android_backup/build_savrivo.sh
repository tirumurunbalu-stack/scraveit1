#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${SAVRIVO_OUTPUT_DIR:-$SCRIPT_DIR/build/savrivo_developer}"
SKIP_TESTS=0

usage() {
  cat <<'USAGE'
Usage: native_android/build_savrivo.sh [--output DIR] [--skip-tests]

Builds and signs developer APKs for:
  - Savrivo Customer
  - Savrivo Control
  - Savrivo Partner

Environment variables:
  ANDROID_SDK_ROOT       Android SDK root (ANDROID_HOME is also accepted)
  JAVA_HOME              JDK containing javac and keytool
  NODE_BIN               Node.js executable used by the validation gate
  SAVRIVO_OUTPUT_DIR     Default output directory
  SAVRIVO_KEYSTORE       Existing developer keystore path
  SAVRIVO_KEY_ALIAS      Alias (default: savrivo-developer)
  SAVRIVO_STORE_PASS     Store password (default for generated dev key: savrivo-dev-only)
  SAVRIVO_KEY_PASS       Key password (defaults to store password)

This creates developer APKs only. Never upload the generated developer key or APKs
to Google Play; production signing material must be created and protected separately.
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
[[ -d "$SDK_ROOT" ]] || { echo "Android SDK not found. Set ANDROID_SDK_ROOT." >&2; exit 2; }

BUILD_TOOLS_DIR=""
BUILD_TOOLS_MAJOR=-1
while IFS= read -r candidate; do
  version="$(basename "$candidate")"
  major="${version%%.*}"
  if [[ "$major" =~ ^[0-9]+$ ]] \
      && [[ -x "$candidate/aapt2" && -x "$candidate/d8" && -x "$candidate/zipalign" && -x "$candidate/apksigner" ]] \
      && (( major > BUILD_TOOLS_MAJOR )); then
    BUILD_TOOLS_MAJOR="$major"
    BUILD_TOOLS_DIR="$candidate"
  fi
done < <(find "$SDK_ROOT/build-tools" -mindepth 1 -maxdepth 1 -type d | sort)
[[ -n "$BUILD_TOOLS_DIR" ]] || { echo "Android build tools (aapt2/d8/zipalign/apksigner) were not found." >&2; exit 2; }

ANDROID_JAR=""
ANDROID_API=-1
while IFS= read -r candidate; do
  api="$(basename "$candidate")"
  api="${api#android-}"
  api="${api%%.*}"
  if [[ "$api" =~ ^[0-9]+$ ]] && [[ -f "$candidate/android.jar" ]] && (( api > ANDROID_API )); then
    ANDROID_API="$api"
    ANDROID_JAR="$candidate/android.jar"
  fi
done < <(find "$SDK_ROOT/platforms" -mindepth 1 -maxdepth 1 -type d | sort)
[[ -f "$ANDROID_JAR" ]] || { echo "An Android platform android.jar was not found." >&2; exit 2; }
(( ANDROID_API >= 36 )) || { echo "Android platform 36 or newer is required (found API $ANDROID_API)." >&2; exit 2; }

if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/javac" ]]; then
  JAVAC="$JAVA_HOME/bin/javac"
  KEYTOOL="$JAVA_HOME/bin/keytool"
else
  JAVAC="$(command -v javac || true)"
  KEYTOOL="$(command -v keytool || true)"
fi
[[ -x "$JAVAC" ]] || { echo "javac was not found. Set JAVA_HOME to a JDK." >&2; exit 2; }
[[ -x "$KEYTOOL" ]] || { echo "keytool was not found. Set JAVA_HOME to a JDK." >&2; exit 2; }
command -v zip >/dev/null 2>&1 || { echo "zip was not found." >&2; exit 2; }

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/savrivo-android-build.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT

KEYSTORE="${SAVRIVO_KEYSTORE:-$SCRIPT_DIR/build/savrivo-developer.keystore}"
KEY_ALIAS="${SAVRIVO_KEY_ALIAS:-savrivo-developer}"
STORE_PASS="${SAVRIVO_STORE_PASS:-savrivo-dev-only}"
KEY_PASS="${SAVRIVO_KEY_PASS:-$STORE_PASS}"

if [[ ! -f "$KEYSTORE" ]]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  echo "Creating developer-only Savrivo keystore at $KEYSTORE"
  "$KEYTOOL" -genkeypair -noprompt \
    -keystore "$KEYSTORE" \
    -storepass "$STORE_PASS" \
    -keypass "$KEY_PASS" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Savrivo Developer, OU=Development, O=Savrivo, L=Nellore, ST=Andhra Pradesh, C=IN"
fi

AAPT2="$BUILD_TOOLS_DIR/aapt2"
D8="$BUILD_TOOLS_DIR/d8"
ZIPALIGN="$BUILD_TOOLS_DIR/zipalign"
APKSIGNER="$BUILD_TOOLS_DIR/apksigner"

build_module() {
  local display_name="$1"
  local module="$2"
  local apk_name="$3"
  local module_root="$SCRIPT_DIR/$module/src/main"
  local manifest="$module_root/AndroidManifest.xml"
  local module_work="$TEMP_ROOT/$module"
  local resource_dir="$module_root/res"

  [[ -f "$manifest" ]] || { echo "Missing manifest for $display_name" >&2; return 1; }
  [[ -d "$module_root/assets" ]] || { echo "Missing assets for $display_name" >&2; return 1; }
  [[ -d "$resource_dir" ]] || resource_dir="$SCRIPT_DIR/app/src/main/res"

  mkdir -p "$module_work/gen" "$module_work/classes" "$module_work/dex" "$module_work/stage/assets"
  echo "Building $display_name"

  "$AAPT2" compile --dir "$resource_dir" -o "$module_work/compiled.zip"
  "$AAPT2" link \
    -I "$ANDROID_JAR" \
    --manifest "$manifest" \
    --java "$module_work/gen" \
    -o "$module_work/unsigned.apk" \
    "$module_work/compiled.zip"

  local package_name
  package_name="$(sed -n 's/.*package="\([^"]*\)".*/\1/p' "$manifest" | head -1)"
  local r_java="$module_work/gen/${package_name//.//}/R.java"
  [[ -f "$r_java" ]] || { echo "Generated R.java not found for $display_name" >&2; return 1; }

  local java_sources=("$r_java")
  while IFS= read -r source; do java_sources+=("$source"); done < <(find "$module_root/java" -type f -name '*.java' | sort)
  "$JAVAC" -source 8 -target 8 -cp "$ANDROID_JAR" -d "$module_work/classes" "${java_sources[@]}"

  local class_files=()
  while IFS= read -r class_file; do class_files+=("$class_file"); done < <(find "$module_work/classes" -type f -name '*.class' | sort)
  "$D8" --lib "$ANDROID_JAR" --min-api 23 --output "$module_work/dex" "${class_files[@]}"

  cp -R "$module_root/assets/." "$module_work/stage/assets/"
  cp "$module_work/dex/classes.dex" "$module_work/stage/classes.dex"
  (
    cd "$module_work/stage"
    zip -q -r -u "$module_work/unsigned.apk" classes.dex assets
  )

  "$ZIPALIGN" -f 4 "$module_work/unsigned.apk" "$module_work/aligned.apk"
  "$APKSIGNER" sign \
    --ks "$KEYSTORE" \
    --ks-key-alias "$KEY_ALIAS" \
    --ks-pass "pass:$STORE_PASS" \
    --key-pass "pass:$KEY_PASS" \
    --v4-signing-enabled false \
    --out "$OUTPUT_DIR/$apk_name" \
    "$module_work/aligned.apk"
  "$APKSIGNER" verify --verbose "$OUTPUT_DIR/$apk_name" >/dev/null
  echo "  Created $OUTPUT_DIR/$apk_name"
}

build_module "Savrivo Customer" "app" "Savrivo-Customer-developer.apk"
build_module "Savrivo Control" "admin" "Savrivo-Control-developer.apk"
build_module "Savrivo Partner" "rider" "Savrivo-Partner-developer.apk"

echo
echo "Developer APK build completed."
echo "Output: $OUTPUT_DIR"
echo "These APKs are locally signed developer artifacts, not Play Store release bundles."
