#!/bin/bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <dist-dir> <version> <channel> <team-id>" >&2
  exit 2
fi

release_dir="$(cd "$1" && pwd)"
expected_version="$2"
expected_channel="$3"
expected_team_id="$4"
script_dir="$(cd "$(dirname "$0")" && pwd)"

temporary_dirs=()
mounted_dirs=()
cleanup() {
  for mounted_dir in "${mounted_dirs[@]}"; do
    hdiutil detach "$mounted_dir" -quiet >/dev/null 2>&1 || true
  done
  for temporary_dir in "${temporary_dirs[@]}"; do
    if [[ "$temporary_dir" == /private/tmp/swob-release-* ]]; then
      rm -rf "$temporary_dir"
    fi
  done
}
trap cleanup EXIT

node "$script_dir/assert-release-assets.mjs" \
  --dir "$release_dir" \
  --version "$expected_version" \
  --channel "$expected_channel"

verify_app() {
  local app_bundle="$1"
  local expected_arch="$2"
  "$script_dir/verify-signed-app.sh" \
    "$app_bundle" \
    "$expected_version" \
    "$expected_channel" \
    "$expected_team_id" \
    "$expected_arch"
}

single_app_in() {
  local container_dir="$1"
  local label="$2"
  local apps=()
  while IFS= read -r -d '' app_bundle; do
    apps+=("$app_bundle")
  done < <(find "$container_dir" -maxdepth 2 -type d -name 'Swob.app' -print0)
  if [[ ${#apps[@]} -ne 1 ]]; then
    echo "Expected exactly one Swob.app in $label, found ${#apps[@]}." >&2
    find "$container_dir" -maxdepth 2 -type d -name '*.app' -print >&2
    return 1
  fi
  printf '%s\n' "${apps[0]}"
}

unpacked_apps=()
while IFS= read -r -d '' app_bundle; do
  unpacked_apps+=("$app_bundle")
done < <(find "$release_dir" -mindepth 2 -maxdepth 3 -type d -name 'Swob.app' -print0)

if [[ ${#unpacked_apps[@]} -ne 2 ]]; then
  echo "Expected two unpacked Swob.app bundles, found ${#unpacked_apps[@]}." >&2
  exit 1
fi

found_arm64=0
found_x86_64=0
for app_bundle in "${unpacked_apps[@]}"; do
  architectures="$(lipo -archs "$app_bundle/Contents/MacOS/Swob")"
  case "$architectures" in
    arm64)
      verify_app "$app_bundle" arm64
      found_arm64=$((found_arm64 + 1))
      ;;
    x86_64)
      verify_app "$app_bundle" x86_64
      found_x86_64=$((found_x86_64 + 1))
      ;;
    *)
      echo "Expected a single-architecture unpacked app, got: $architectures" >&2
      exit 1
      ;;
  esac
done

if [[ $found_arm64 -ne 1 || $found_x86_64 -ne 1 ]]; then
  echo "Expected exactly one arm64 and one x86_64 unpacked application." >&2
  exit 1
fi

for artifact_arch in arm64 x64; do
  expected_binary_arch="$artifact_arch"
  if [[ "$artifact_arch" == "x64" ]]; then
    expected_binary_arch="x86_64"
  fi

  dmg_file="$release_dir/swob-${expected_version}-${artifact_arch}.dmg"
  zip_file="$release_dir/swob-${expected_version}-${artifact_arch}.zip"

  extraction_dir="$(mktemp -d "/private/tmp/swob-release-zip-${artifact_arch}.XXXXXX")"
  temporary_dirs+=("$extraction_dir")
  ditto -x -k "$zip_file" "$extraction_dir"
  zip_app="$(single_app_in "$extraction_dir" "$zip_file")"
  verify_app "$zip_app" "$expected_binary_arch"

  hdiutil verify "$dmg_file"
  xcrun stapler validate "$dmg_file"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg_file"

  mount_dir="$(mktemp -d "/private/tmp/swob-release-dmg-${artifact_arch}.XXXXXX")"
  temporary_dirs+=("$mount_dir")
  hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$dmg_file" >/dev/null
  mounted_dirs+=("$mount_dir")
  dmg_app="$(single_app_in "$mount_dir" "$dmg_file")"
  verify_app "$dmg_app" "$expected_binary_arch"
  hdiutil detach "$mount_dir" -quiet
done

echo "All unpacked, ZIP and mounted-DMG applications passed the shared fail-closed verifier."
