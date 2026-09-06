#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACT_DIR="${1:-$SCRIPT_DIR/../build/savrivo_staging_sandbox}"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

if [[ -z "$SDK_ROOT" && -d "$HOME/Library/Android/sdk" ]]; then
  SDK_ROOT="$HOME/Library/Android/sdk"
fi
ADB_BIN="${ADB_BIN:-${SDK_ROOT:+$SDK_ROOT/platform-tools/adb}}"
[[ -x "$ADB_BIN" ]] || {
  echo "adb was not found. Install Android platform-tools or set ADB_BIN." >&2
  exit 2
}

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

package_installed() {
  local serial="$1" package_name="$2"
  "$ADB_BIN" -s "$serial" shell pm list packages "$package_name" 2>/dev/null \
    | tr -d '\r' \
    | grep -Fx "package:$package_name" >/dev/null 2>&1
}

package_version() {
  local serial="$1" package_name="$2"
  "$ADB_BIN" -s "$serial" shell dumpsys package "$package_name" 2>/dev/null \
    | sed -n 's/^[[:space:]]*versionName=//p' \
    | head -n 1 \
    | tr -d '\r'
}

install_role() {
  local serial="$1" apk="$2" label="$3" package_name="$4" device_slot="${5:-$serial}"
  [[ -f "$apk" ]] || {
    echo "Missing APK for $label: $apk" >&2
    exit 2
  }
  device_online "$serial" || {
    echo "Device $serial for $label is not attached or not authorized." >&2
    exit 2
  }
  echo "Installing $label on $device_slot ($serial)"
  "$ADB_BIN" -s "$serial" install -r -d "$apk"
  package_installed "$serial" "$package_name" || {
    echo "Package $package_name for $label was not visible after install on $serial." >&2
    exit 2
  }
  local version_name
  version_name="$(package_version "$serial" "$package_name")"
  [[ -n "$version_name" ]] || version_name="installed"
  echo "Verified $label package $package_name on $device_slot ($serial), version ${version_name}."
}

install_two_phone_mode() {
  require_serial SCRAVEIT_PHONE1_SERIAL
  require_serial SCRAVEIT_PHONE2_SERIAL
  install_role "$SCRAVEIT_PHONE1_SERIAL" \
    "$ARTIFACT_DIR/Scraveit-Customer-STAGING-SANDBOX-debug.apk" \
    "Customer" "com.feastly.app" "Phone 1"
  install_role "$SCRAVEIT_PHONE1_SERIAL" \
    "$ARTIFACT_DIR/Scraveit-Restaurant-STAGING-SANDBOX-debug.apk" \
    "Restaurant" "com.feastly.restaurant" "Phone 1"
  install_role "$SCRAVEIT_PHONE1_SERIAL" \
    "$ARTIFACT_DIR/Scraveit-Admin-STAGING-SANDBOX-debug.apk" \
    "Admin" "com.feastly.admin" "Phone 1"
  install_role "$SCRAVEIT_PHONE2_SERIAL" \
    "$ARTIFACT_DIR/Scraveit-Rider-STAGING-SANDBOX-debug.apk" \
    "Rider" "com.feastly.rider" "Phone 2"
}

install_multi_device_mode() {
  require_serial SCRAVEIT_CUSTOMER_SERIAL
  require_serial SCRAVEIT_RESTAURANT_SERIAL
  require_serial SCRAVEIT_RIDER_A_SERIAL
  require_serial SCRAVEIT_RIDER_B_SERIAL

  install_role "$SCRAVEIT_CUSTOMER_SERIAL" \
    "$ARTIFACT_DIR/Scraveit-Customer-STAGING-SANDBOX-debug.apk" \
    "Customer" "com.feastly.app" "Customer device"
  install_role "$SCRAVEIT_RESTAURANT_SERIAL" \
    "$ARTIFACT_DIR/Scraveit-Restaurant-STAGING-SANDBOX-debug.apk" \
    "Restaurant" "com.feastly.restaurant" "Restaurant device"
  install_role "$SCRAVEIT_RIDER_A_SERIAL" \
    "$ARTIFACT_DIR/Scraveit-Rider-STAGING-SANDBOX-debug.apk" \
    "Rider A" "com.feastly.rider" "Rider A device"
  install_role "$SCRAVEIT_RIDER_B_SERIAL" \
    "$ARTIFACT_DIR/Scraveit-Rider-STAGING-SANDBOX-debug.apk" \
    "Rider B" "com.feastly.rider" "Rider B device"

  if [[ -n "${SCRAVEIT_ADMIN_SERIAL:-}" ]]; then
    install_role "$SCRAVEIT_ADMIN_SERIAL" \
      "$ARTIFACT_DIR/Scraveit-Admin-STAGING-SANDBOX-debug.apk" \
      "Admin" "com.feastly.admin" "Admin device"
  else
    echo "SCRAVEIT_ADMIN_SERIAL is not set; skipping Admin installation."
  fi
}

if [[ -n "${SCRAVEIT_PHONE1_SERIAL:-}" || -n "${SCRAVEIT_PHONE2_SERIAL:-}" ]]; then
  install_two_phone_mode
else
  install_multi_device_mode
fi

echo "Staging sandbox installation completed."
