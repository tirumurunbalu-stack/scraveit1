#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACT_DIR="${1:-$SCRIPT_DIR/../build/savrivo_staging_sandbox}"
EVIDENCE_DIR="${SCRAVEIT_STAGING_EVIDENCE_DIR:-$SCRIPT_DIR/../build/savrivo_staging_preflight}"
STAGING_PROJECT_ID="${SCRAVEIT_STAGING_PROJECT_ID:-savrivo-app}"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

if [[ -z "$SDK_ROOT" && -d "$HOME/Library/Android/sdk" ]]; then
  SDK_ROOT="$HOME/Library/Android/sdk"
fi
ADB_BIN="${ADB_BIN:-${SDK_ROOT:+$SDK_ROOT/platform-tools/adb}}"
[[ -x "$ADB_BIN" ]] || {
  echo "adb was not found. Install Android platform-tools or set ADB_BIN." >&2
  exit 2
}

mkdir -p "$EVIDENCE_DIR"
EVIDENCE_DIR="$(cd "$EVIDENCE_DIR" && pwd)"

require_serial() {
  local env_name="$1"
  local value="${!env_name:-}"
  [[ -n "$value" ]] || {
    echo "Set $env_name to an attached Android device serial." >&2
    exit 2
  }
}

device_online() {
  local serial="$1"
  "$ADB_BIN" devices | awk 'NR>1 && $2 == "device" {print $1}' | grep -Fx "$serial" >/dev/null 2>&1
}

device_prop() {
  local serial="$1" key="$2"
  "$ADB_BIN" -s "$serial" shell getprop "$key" 2>/dev/null | tr -d '\r'
}

webview_update_state() {
  local serial="$1"
  "$ADB_BIN" -s "$serial" shell dumpsys webviewupdate 2>/dev/null | tr -d '\r'
}

package_version() {
  local serial="$1" package_name="$2"
  "$ADB_BIN" -s "$serial" shell dumpsys package "$package_name" 2>/dev/null \
    | sed -n 's/^[[:space:]]*versionName=//p' \
    | head -n 1 \
    | tr -d '\r'
}

package_installed() {
  local serial="$1" package_name="$2"
  "$ADB_BIN" -s "$serial" shell pm list packages "$package_name" 2>/dev/null \
    | tr -d '\r' \
    | grep -Fx "package:$package_name" >/dev/null 2>&1
}

hash_file() {
  local file="$1"
  shasum -a 256 "$file" | awk '{print $1}'
}

requires_webview_provider() {
  local package_name="$1"
  [[ "$package_name" == "com.feastly.app" || "$package_name" == "com.feastly.restaurant" || "$package_name" == "com.feastly.admin" ]]
}

validate_webview_provider() {
  local serial="$1" slot="$2" state
  state="$(webview_update_state "$serial")"
  [[ -n "$state" ]] || {
    echo "Could not read WebView provider state from $slot ($serial)." >&2
    exit 2
  }
  grep -F "Any WebView package installed: true" <<<"$state" >/dev/null || {
    echo "No active WebView provider is installed on $slot ($serial)." >&2
    exit 2
  }
  if grep -F "Current WebView package is null" <<<"$state" >/dev/null; then
    echo "WebView provider is null on $slot ($serial)." >&2
    exit 2
  fi
}

configure_role_rows() {
  ROLE_ROWS=()
  MODE_LABEL=""
  MODE_NOTE=""

  if [[ -n "${SCRAVEIT_PHONE1_SERIAL:-}" || -n "${SCRAVEIT_PHONE2_SERIAL:-}" ]]; then
    require_serial SCRAVEIT_PHONE1_SERIAL
    require_serial SCRAVEIT_PHONE2_SERIAL
    MODE_LABEL="two-phone"
    MODE_NOTE="Phone 1 carries Customer + Restaurant + Admin; Phone 2 carries Rider. Rider race tests still require a third phone later."
    ROLE_ROWS=(
      "Phone 1|Customer|$SCRAVEIT_PHONE1_SERIAL|com.feastly.app|$ARTIFACT_DIR/Scraveit-Customer-STAGING-SANDBOX-debug.apk"
      "Phone 1|Restaurant|$SCRAVEIT_PHONE1_SERIAL|com.feastly.restaurant|$ARTIFACT_DIR/Scraveit-Restaurant-STAGING-SANDBOX-debug.apk"
      "Phone 1|Admin|$SCRAVEIT_PHONE1_SERIAL|com.feastly.admin|$ARTIFACT_DIR/Scraveit-Admin-STAGING-SANDBOX-debug.apk"
      "Phone 2|Rider|$SCRAVEIT_PHONE2_SERIAL|com.feastly.rider|$ARTIFACT_DIR/Scraveit-Rider-STAGING-SANDBOX-debug.apk"
    )
    return
  fi

  require_serial SCRAVEIT_CUSTOMER_SERIAL
  require_serial SCRAVEIT_RESTAURANT_SERIAL
  require_serial SCRAVEIT_RIDER_A_SERIAL
  require_serial SCRAVEIT_RIDER_B_SERIAL
  MODE_LABEL="multi-device"
  MODE_NOTE="Dedicated role-per-device staging layout."
  ROLE_ROWS=(
    "Customer device|Customer|$SCRAVEIT_CUSTOMER_SERIAL|com.feastly.app|$ARTIFACT_DIR/Scraveit-Customer-STAGING-SANDBOX-debug.apk"
    "Restaurant device|Restaurant|$SCRAVEIT_RESTAURANT_SERIAL|com.feastly.restaurant|$ARTIFACT_DIR/Scraveit-Restaurant-STAGING-SANDBOX-debug.apk"
    "Rider A device|Rider A|$SCRAVEIT_RIDER_A_SERIAL|com.feastly.rider|$ARTIFACT_DIR/Scraveit-Rider-STAGING-SANDBOX-debug.apk"
    "Rider B device|Rider B|$SCRAVEIT_RIDER_B_SERIAL|com.feastly.rider|$ARTIFACT_DIR/Scraveit-Rider-STAGING-SANDBOX-debug.apk"
  )
  if [[ -n "${SCRAVEIT_ADMIN_SERIAL:-}" ]]; then
    ROLE_ROWS+=("Admin device|Admin|$SCRAVEIT_ADMIN_SERIAL|com.feastly.admin|$ARTIFACT_DIR/Scraveit-Admin-STAGING-SANDBOX-debug.apk")
  fi
}

declare -a ROLE_ROWS
MODE_LABEL=""
MODE_NOTE=""

node "$SCRIPT_DIR/verify_staging_firebase.mjs" "$STAGING_PROJECT_ID"
configure_role_rows

for row in "${ROLE_ROWS[@]}"; do
  IFS='|' read -r device_slot role serial _package_name apk_path <<<"$row"
  [[ -f "$apk_path" ]] || {
    echo "Missing APK for $role: $apk_path" >&2
    exit 2
  }
  device_online "$serial" || {
    echo "Device $serial for $device_slot / $role is not attached, unauthorized, or not ready." >&2
    exit 2
  }
done

checked_webview_slots='|'
for row in "${ROLE_ROWS[@]}"; do
  IFS='|' read -r device_slot role serial package_name _apk_path <<<"$row"
  requires_webview_provider "$package_name" || continue
  [[ "$checked_webview_slots" == *"|$serial|"* ]] && continue
  validate_webview_provider "$serial" "$device_slot"
  checked_webview_slots+="$serial|"
done

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
REPORT_FILE="$EVIDENCE_DIR/staging-device-preflight-$TIMESTAMP.md"

{
  printf '# Scraveit staging device preflight\n\n'
  printf 'Generated: %s\n\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  printf 'Firebase staging project: `%s`\n\n' "$STAGING_PROJECT_ID"
  printf 'Deployment mode: `%s`\n\n' "$MODE_LABEL"
  printf '%s\n\n' "$MODE_NOTE"
  printf 'Artifact directory: `%s`\n\n' "$ARTIFACT_DIR"
  printf '## APK hashes\n\n'
  printf '| Device slot | Role | APK | SHA-256 |\n'
  printf '|---|---|---|---|\n'
  for row in "${ROLE_ROWS[@]}"; do
    IFS='|' read -r device_slot role _serial _package_name apk_path <<<"$row"
    printf '| %s | %s | `%s` | `%s` |\n' "$device_slot" "$role" "$(basename "$apk_path")" "$(hash_file "$apk_path")"
  done
  printf '\n## Connected staging devices\n\n'
  printf '| Device slot | Role | Serial | Manufacturer | Model | Android | API | Package | Installed version | WebView |\n'
  printf '|---|---|---|---|---|---|---|---|---|---|\n'
  for row in "${ROLE_ROWS[@]}"; do
    IFS='|' read -r device_slot role serial package_name _apk_path <<<"$row"
    manufacturer="$(device_prop "$serial" ro.product.manufacturer)"
    model="$(device_prop "$serial" ro.product.model)"
    release="$(device_prop "$serial" ro.build.version.release)"
    api="$(device_prop "$serial" ro.build.version.sdk)"
    if package_installed "$serial" "$package_name"; then
      version_name="$(package_version "$serial" "$package_name")"
      [[ -n "$version_name" ]] || version_name="installed (version unavailable)"
    else
      version_name="not installed"
    fi
    webview_note="not required"
    if requires_webview_provider "$package_name"; then
      current_provider="$(webview_update_state "$serial" | sed -n 's/.*Current WebView package (name, version): (\([^,]*\),.*/\1/p' | head -n 1)"
      [[ -n "$current_provider" ]] || current_provider="provider unavailable"
      webview_note="$current_provider"
    fi
    printf '| %s | %s | `%s` | %s | %s | %s | %s | `%s` | %s | %s |\n' \
      "$device_slot" "$role" "$serial" "${manufacturer:-unknown}" "${model:-unknown}" "${release:-unknown}" "${api:-unknown}" "$package_name" "$version_name" "$webview_note"
  done
  printf '\n## Next step\n\n'
  printf 'Install or refresh the staging sandbox builds with:\n\n'
  printf '```sh\n'
  printf 'native_android/tools/install_staging_apks.sh \\\n'
  printf '  native_android/build/savrivo_staging_sandbox\n'
  printf '```\n'
} >"$REPORT_FILE"

echo "Staging device preflight passed."
echo "Evidence report: $REPORT_FILE"
