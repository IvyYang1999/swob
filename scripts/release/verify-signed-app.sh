#!/bin/bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 <Swob.app> <version> <channel> <team-id> <arm64|x86_64>" >&2
  exit 2
fi

app_bundle="$1"
expected_version="$2"
expected_channel="$3"
expected_team_id="$4"
expected_arch="$5"
script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

if [[ ! -d "$app_bundle" ]]; then
  echo "Missing application bundle: $app_bundle" >&2
  exit 1
fi
if [[ "$expected_arch" != "arm64" && "$expected_arch" != "x86_64" ]]; then
  echo "Unsupported expected architecture: $expected_arch" >&2
  exit 2
fi

codesign --verify --deep --strict --verbose=2 "$app_bundle"
signature_info="$(codesign -dv --verbose=4 "$app_bundle" 2>&1)"
requirement_info="$(codesign -dr - "$app_bundle" 2>&1)"

if ! grep -q '^Authority=Developer ID Application:' <<< "$signature_info"; then
  echo "Developer ID Application authority is missing: $app_bundle" >&2
  exit 1
fi
if ! grep -q "^TeamIdentifier=${expected_team_id}$" <<< "$signature_info"; then
  echo "Unexpected or missing TeamIdentifier: $app_bundle" >&2
  exit 1
fi
if grep -q '^Signature=adhoc$' <<< "$signature_info"; then
  echo "Ad-hoc signature is forbidden: $app_bundle" >&2
  exit 1
fi
if ! grep -Eq '^CodeDirectory .*flags=.*runtime' <<< "$signature_info"; then
  echo "Hardened runtime signature flag is missing: $app_bundle" >&2
  exit 1
fi
if grep -q 'designated => cdhash' <<< "$requirement_info"; then
  echo "Build-specific CDHash designated requirement is forbidden: $app_bundle" >&2
  exit 1
fi

bundle_id="$(plutil -extract CFBundleIdentifier raw "$app_bundle/Contents/Info.plist")"
bundle_version="$(plutil -extract CFBundleShortVersionString raw "$app_bundle/Contents/Info.plist")"
if [[ "$bundle_id" != "com.swob.app" ]]; then
  echo "Unexpected bundle identifier: $bundle_id" >&2
  exit 1
fi
if [[ "$bundle_version" != "$expected_version" ]]; then
  echo "Unexpected bundle version: expected=$expected_version actual=$bundle_version" >&2
  exit 1
fi

executable="$app_bundle/Contents/MacOS/Swob"
architectures="$(lipo -archs "$executable")"
if [[ "$architectures" != "$expected_arch" ]]; then
  echo "Expected a single $expected_arch architecture, got: $architectures" >&2
  exit 1
fi

update_config="$app_bundle/Contents/Resources/app-update.yml"
if [[ ! -f "$update_config" ]]; then
  echo "Missing packaged app-update.yml: $app_bundle" >&2
  exit 1
fi
for expected_line in \
  'provider: github' \
  'owner: IvyYang1999' \
  'repo: swob' \
  "channel: ${expected_channel}"; do
  if ! grep -qx "$expected_line" "$update_config"; then
    echo "app-update.yml is missing: $expected_line" >&2
    exit 1
  fi
done
if grep -qx 'channel: latest' "$update_config"; then
  echo "Retired latest update channel is forbidden" >&2
  exit 1
fi

spctl --assess --type execute --verbose=4 "$app_bundle"
xcrun stapler validate "$app_bundle"

app_asar="$app_bundle/Contents/Resources/app.asar"
if [[ ! -f "$app_asar" ]]; then
  echo "Missing packaged app.asar: $app_bundle" >&2
  exit 1
fi
inventory_dir="$(mktemp -d /private/tmp/swob-package-inventory.XXXXXX)"
cleanup_inventory() {
  rm -rf "$inventory_dir"
}
trap cleanup_inventory EXIT
node "$repo_root/scripts/check-package.mjs" \
  --asar "$app_asar" \
  --inventory-dir "$inventory_dir"
cleanup_inventory
trap - EXIT

echo "Verified signed, notarized and package-allowlisted Swob ${expected_version} (${expected_arch}, channel=${expected_channel})."
