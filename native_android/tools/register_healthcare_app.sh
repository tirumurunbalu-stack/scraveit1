#!/usr/bin/env bash
# One-time: register the Scraveit Health care store app (com.feastly.healthcare)
# in Firebase (savrivo-app), give it the same signing fingerprints as the Dairy
# app (debug, upload and Play signing keys, so Google sign-in works), and add
# its config to restaurant/google-services.json. Safe to run again.
# Prints no keys.
set -euo pipefail

PROJECT="savrivo-app"
PKG="com.feastly.healthcare"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSON="$ROOT/restaurant/google-services.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

app_id() {
  firebase apps:list ANDROID --project "$PROJECT" --json 2>/dev/null | python3 -c '
import json, sys
apps = json.load(sys.stdin).get("result", [])
print(next((a["appId"] for a in apps if a.get("packageName") == sys.argv[1]), ""))' "$PKG"
}

ID="$(app_id)"
if [[ -z "$ID" ]]; then
  echo "Registering $PKG in Firebase..."
  firebase apps:create ANDROID "Scraveit Health care" --package-name "$PKG" --project "$PROJECT" >/dev/null
  ID="$(app_id)"
fi
[[ -n "$ID" ]] || { echo "Could not find the new app in Firebase." >&2; exit 1; }
echo "Firebase app: $ID"

# The same SHA-1 fingerprints the Dairy app already has.
python3 - "$JSON" > "$TMP/shas" <<'EOF'
import json, sys
for c in json.load(open(sys.argv[1]))["client"]:
    if c["client_info"]["android_client_info"]["package_name"] == "com.feastly.dairy":
        for o in c.get("oauth_client", []):
            h = (o.get("android_info") or {}).get("certificate_hash")
            if h: print(h)
EOF
existing="$(firebase apps:android:sha:list "$ID" --project "$PROJECT" 2>/dev/null | tr 'A-F' 'a-f' | tr -d ':' || true)"
while read -r sha; do
  [[ -z "$sha" ]] && continue
  if grep -q "$sha" <<<"$existing"; then echo "Fingerprint ${sha:0:6}… already added"; continue; fi
  firebase apps:android:sha:create "$ID" "$sha" --project "$PROJECT" >/dev/null && echo "Added fingerprint ${sha:0:6}…"
done < "$TMP/shas"

# Give Google a moment to create the Android sign-in clients, then merge the config.
sleep 20
firebase apps:sdkconfig ANDROID "$ID" --project "$PROJECT" --out "$TMP/new.json" >/dev/null
python3 - "$JSON" "$TMP/new.json" "$PKG" <<'EOF'
import json, sys
path, new_path, pkg = sys.argv[1:]
data, new = json.load(open(path)), json.load(open(new_path))
client = next(c for c in new["client"] if c["client_info"]["android_client_info"]["package_name"] == pkg)
data["client"] = [c for c in data["client"] if c["client_info"]["android_client_info"]["package_name"] != pkg] + [client]
data["client"].sort(key=lambda c: c["client_info"]["android_client_info"]["package_name"])
open(path, "w").write(json.dumps(data, indent=2))
print("google-services.json now has:", ", ".join(c["client_info"]["android_client_info"]["package_name"] for c in data["client"]))
print("Android sign-in clients for Health care:", sum(1 for o in client.get("oauth_client", []) if o.get("client_type") == 1))
EOF
echo "Done. Next: native_android/tools/install_on_phone.sh healthcare"
