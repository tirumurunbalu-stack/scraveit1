#!/usr/bin/env bash
# Build one app and install it on the phone plugged in over USB.
#   native_android/tools/install_on_phone.sh restaurant   (or: customer, partner, admin, grocery, dairy)
# Finds Android Studio's Java and adb by itself. If the phone has the Play
# version, it offers to uninstall it first (that signs the app out).
set -euo pipefail

APP="${1:-restaurant}"
case "$APP" in
  restaurant) TASK=":restaurant:installRestaurantDebug"; PKG="com.feastly.restaurant" ;;
  grocery)    TASK=":restaurant:installGroceryDebug";    PKG="com.feastly.grocery" ;;
  dairy)      TASK=":restaurant:installDairyDebug";      PKG="com.feastly.dairy" ;;
  customer)   TASK=":customer:installDebug";             PKG="" ;;
  partner|rider) TASK=":rider:installDebug";             PKG="" ;;
  admin)      TASK=":admin:installDebug";                PKG="" ;;
  *) echo "Unknown app: $APP (use restaurant, grocery, dairy, customer, partner or admin)" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
[[ -d "$SDK" ]] || { echo "Android SDK not found at $SDK. Open Android Studio once to install it." >&2; exit 2; }
export ANDROID_HOME="$SDK"
ADB="$SDK/platform-tools/adb"
[[ -f "$ROOT/local.properties" ]] || echo "sdk.dir=$SDK" > "$ROOT/local.properties"

pick_java() {
  local c v
  for c in "${JAVA_HOME:-}" \
           "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
           $( [[ "$(uname -s)" == Darwin ]] && /usr/libexec/java_home -V 2>&1 | sed -n 's/.* \(\/.*\/Contents\/Home\)$/\1/p' ); do
    [[ -n "$c" && -x "$c/bin/java" ]] || continue
    v="$("$c/bin/java" -version 2>&1 | sed -n '1s/.*version "\([0-9][0-9]*\).*/\1/p')"
    if [[ "$v" =~ ^[0-9]+$ ]] && (( v >= 17 && v <= 25 )); then echo "$c"; return 0; fi
  done
  return 1
}
JAVA_HOME="$(pick_java)" || { echo "Java 17+ not found. Install Android Studio (it includes Java)." >&2; exit 2; }
export JAVA_HOME
echo "Using Java: $JAVA_HOME"

"$ADB" start-server >/dev/null
if ! "$ADB" devices | awk 'NR>1 && $2=="device"' | grep -q .; then
  echo "No phone found. Plug it in by USB, turn on USB debugging and tap Allow on the phone." >&2
  "$ADB" devices >&2
  exit 2
fi

cd "$ROOT"
if ! ./gradlew --stop >/dev/null 2>&1; then :; fi
set +e
./gradlew "$TASK" 2>&1 | tee /tmp/scraveit-install.log
status=${PIPESTATUS[0]}
set -e
if (( status != 0 )) && [[ -n "$PKG" ]] && grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE\|signatures do not match" /tmp/scraveit-install.log; then
  echo
  read -r -p "The phone has a different (Play) build of $PKG. Uninstall it and install this one? You will need to sign in again. [y/N] " ok
  if [[ "$ok" =~ ^[Yy]$ ]]; then
    "$ADB" uninstall "$PKG"
    ./gradlew "$TASK"
    status=$?
  fi
fi
(( status == 0 )) && echo "Installed. Open the app on the phone."
exit "$status"
