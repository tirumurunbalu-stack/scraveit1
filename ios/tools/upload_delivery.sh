#!/usr/bin/env bash
# Build the iOS delivery partner app (Scraveit Partner) and upload it to App Store Connect / TestFlight.
# Same steps as upload_customer.sh, with the Delivery scheme and its own
# build number (the "# delivery-build" line in project.yml).
# Usage: ios/tools/upload_delivery.sh            (bumps the build number by 1)
#        ios/tools/upload_delivery.sh --no-bump  (uploads the current number)
set -euo pipefail
IOS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$IOS/tools"
KEY_ID="TARJN3PY7P"
ISSUER="6f9cb725-b033-41c7-a751-23be24ca3368"
KEY="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
[[ -f "$KEY" ]] || { echo "API key file missing: $KEY" >&2; exit 2; }
cd "$IOS"
build_number() { sed -n 's/^ *CURRENT_PROJECT_VERSION: "\([0-9]*\)" # delivery-build.*/\1/p' project.yml; }
cur=$(build_number)
[[ "$cur" =~ ^[0-9]+$ ]] || { echo "delivery-build line not found in project.yml" >&2; exit 2; }
if [[ "${1:-}" != "--no-bump" ]]; then
  sed -i '' "s/^\( *CURRENT_PROJECT_VERSION: \)\"$cur\"\( # delivery-build\)/\1\"$((cur+1))\"\2/" project.yml
fi
echo "Delivery partner build number: $(build_number)"
xcodegen >/dev/null
ARCHIVE=build/Scraveit-Delivery.xcarchive
OUT=build/upload-delivery
rm -rf "$ARCHIVE" "$OUT"
xcodebuild archive -project Scraveit.xcodeproj -scheme Delivery -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM=8XH6VGP7QS CODE_SIGNING_ALLOWED=NO 2>&1 | grep -E "error:|ARCHIVE"
APP="$ARCHIVE/Products/Applications/ScraveitPartner.app"
[[ -f "$APP/www/premium.html" && -f "$APP/www/premium.js" ]] || { echo "web screens missing from the app" >&2; exit 3; }
[[ -f "$APP/rider_offer.caf" && -f "$APP/rider_offer_loop.wav" ]] || { echo "alarm sounds missing from the app" >&2; exit 3; }
# An unsigned archive loses its entitlements (push); put them back.
codesign -f -s "Apple Development" --entitlements "$TOOLS/delivery-signing-entitlements.plist" "$APP"
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -q "aps-environment" || { echo "push entitlement missing" >&2; exit 3; }
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -q "usernotifications.time-sensitive" || { echo "time-sensitive entitlement missing" >&2; exit 3; }
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$TOOLS/upload.plist" \
  -exportPath "$OUT" -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER" \
  2>&1 | grep -E "error|Upload succeeded|EXPORT"
