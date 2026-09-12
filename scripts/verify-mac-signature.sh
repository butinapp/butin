#!/usr/bin/env bash
# Verifies a macOS build: the app must pass a deep, strict codesign check, be signed by the expected Developer ID
# authority, carry a stapled notarization ticket, and be accepted by Gatekeeper as a notarized Developer ID app.
# An ad-hoc or missing signature fails the authority, stapler and Gatekeeper checks.
#
#   bash scripts/verify-mac-signature.sh "packages/core/release/mac-arm64/Butin.app" \
#     "Developer ID Application: Yann Allard (4ZJR6M393A)"
set -u
app="$1"
authority="$2"
failed=0

if [ ! -d "$app" ]; then
  echo "FAIL no app at $app"
  exit 1
fi

check() {
  local label="$1"
  shift
  if "$@" > /dev/null 2>&1; then echo "ok   $label"; else echo "FAIL $label"; failed=1; fi
}

check "codesign --deep --strict" codesign --verify --deep --strict "$app"
check "authority: $authority" sh -c 'codesign -dvv "$1" 2>&1 | grep -qxF "Authority=$2"' _ "$app" "$authority"
check "notarization ticket stapled" xcrun stapler validate "$app"
check "Gatekeeper: Notarized Developer ID" sh -c 'spctl --assess --type execute -vv "$1" 2>&1 | grep -q "source=Notarized Developer ID"' _ "$app"

exit $failed
