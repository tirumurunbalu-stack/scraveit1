#!/usr/bin/env bash
# Signs the release bundles in build/play-store with your Google Play upload key.
#
# The key lives outside this repository (default ~/scraveit-upload-key) and is
# never committed. This script never reads or stores a password: keytool and
# jarsigner ask you for it themselves.
#
#   First time:  ./sign_play_bundles.sh --create-key
#   Every time:  ./gradlew bundleProduction && ./sign_play_bundles.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$SCRIPT_DIR/build/play-store"
KEY_DIR="${SCRAVEIT_UPLOAD_KEY_DIR:-$HOME/scraveit-upload-key}"
KEYSTORE="$KEY_DIR/scraveit-upload.jks"
ALIAS="scraveit-upload"

if [[ -z "${JAVA_HOME:-}" && -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/}"

if [[ "${1:-}" == "--create-key" ]]; then
  if [[ -f "$KEYSTORE" ]]; then echo "An upload key already exists at $KEYSTORE. Keep using it." >&2; exit 1; fi
  mkdir -p "$KEY_DIR" && chmod 700 "$KEY_DIR"
  echo "Creating your upload key. Choose a strong password and store it in your password manager."
  echo "If this key or its password is lost, you must ask Google Play support to reset it."
  "${JAVA_BIN}keytool" -genkeypair -v -keystore "$KEYSTORE" -alias "$ALIAS" \
    -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=SCRAVEIT PRIVATE LIMITED, O=SCRAVEIT PRIVATE LIMITED, L=Nellore, ST=Andhra Pradesh, C=IN"
  chmod 600 "$KEYSTORE"
  echo "Upload key created at $KEYSTORE. Back up this file somewhere safe (not in git)."
  exit 0
fi

[[ -f "$KEYSTORE" ]] || { echo "No upload key at $KEYSTORE. Run: ./sign_play_bundles.sh --create-key" >&2; exit 1; }
shopt -s nullglob
bundles=("$BUNDLE_DIR"/*.aab)
[[ ${#bundles[@]} -gt 0 ]] || { echo "No bundles in $BUNDLE_DIR." >&2; exit 1; }

for bundle in "${bundles[@]}"; do
  echo "Signing $(basename "$bundle")"
  "${JAVA_BIN}jarsigner" -keystore "$KEYSTORE" -sigalg SHA256withRSA -digestalg SHA-256 "$bundle" "$ALIAS"
  "${JAVA_BIN}jarsigner" -verify "$bundle" >/dev/null && echo "  signed and verified"
done
echo "Signed bundles are ready in $BUNDLE_DIR"
