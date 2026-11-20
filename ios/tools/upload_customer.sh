#!/usr/bin/env bash
# Build the iOS Customer app and upload it to App Store Connect / TestFlight.
# Uses the App Store Connect API key (Admin, "Mac upload admin"), so it never needs
# the Xcode Apple-account sign-in and works while the Mac screen is locked.
# Usage: ios/tools/upload_customer.sh            (bumps the build number by 1)
#        ios/tools/upload_customer.sh --no-bump  (re-uploads the current number)
set -euo pipefail
IOS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$IOS/tools"
KEY_ID="TARJN3PY7P"
ISSUER="6f9cb725-b033-41c7-a751-23be24ca3368"
KEY="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
[[ -f "$KEY" ]] || { echo "API key file missing: $KEY" >&2; exit 2; }
cd "$IOS"
if [[ "${1:-}" != "--no-bump" ]]; then
  cur=$(sed -n 's/.*CURRENT_PROJECT_VERSION: "\([0-9]*\)".*/\1/p' project.yml | head -1)
  sed -i '' "s/CURRENT_PROJECT_VERSION: \"$cur\"/CURRENT_PROJECT_VERSION: \"$((cur+1))\"/" project.yml
fi
echo "Build number: $(sed -n 's/.*CURRENT_PROJECT_VERSION: "\([0-9]*\)".*/\1/p' project.yml | head -1)"
xcodegen >/dev/null
ARCHIVE=build/Scraveit-Customer.xcarchive
rm -rf "$ARCHIVE" build/upload
xcodebuild archive -project Scraveit.xcodeproj -scheme Customer -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM=8XH6VGP7QS CODE_SIGNING_ALLOWED=NO 2>&1 | grep -E "error:|ARCHIVE"
APP="$ARCHIVE/Products/Applications/Scraveit.app"
# An unsigned archive loses its entitlements (push, Sign in with Apple); put them back.
codesign -f -s "Apple Development" --entitlements "$TOOLS/customer-signing-entitlements.plist" "$APP"
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -q "aps-environment" || { echo "push entitlement missing" >&2; exit 3; }
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$TOOLS/upload.plist" \
  -exportPath build/upload -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER" \
  2>&1 | grep -E "error|Upload succeeded|EXPORT"
