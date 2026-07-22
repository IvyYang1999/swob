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

app_bundles=()
while IFS= read -r -d '' app_bundle; do
  app_bundles+=("$app_bundle")
done < <(find "$release_dir" -maxdepth 3 -type d -name 'Swob.app' -print0)

if [[ ${#app_bundles[@]} -ne 2 ]]; then
  echo "Expected two unpacked Swob.app bundles, found ${#app_bundles[@]}." >&2
  exit 1
fi

found_arm64=0
found_x86_64=0
for app_bundle in "${app_bundles[@]}"; do
  architectures="$(lipo -archs "$app_bundle/Contents/MacOS/Swob")"
  if grep -qw arm64 <<< "$architectures"; then
    "$script_dir/verify-signed-app.sh" "$app_bundle" "$expected_version" "$expected_channel" "$expected_team_id" arm64
    found_arm64=$((found_arm64 + 1))
  elif grep -qw x86_64 <<< "$architectures"; then
    "$script_dir/verify-signed-app.sh" "$app_bundle" "$expected_version" "$expected_channel" "$expected_team_id" x86_64
    found_x86_64=$((found_x86_64 + 1))
  else
    echo "Unsupported application architecture: $architectures" >&2
    exit 1
  fi
done

if [[ $found_arm64 -ne 1 || $found_x86_64 -ne 1 ]]; then
  echo "Expected exactly one arm64 and one x86_64 application." >&2
  exit 1
fi

for arch in arm64 x64; do
  dmg_file="$release_dir/swob-${expected_version}-${arch}.dmg"
  zip_file="$release_dir/swob-${expected_version}-${arch}.zip"
  blockmap_file="${zip_file}.blockmap"
  for required_file in "$dmg_file" "$zip_file" "$blockmap_file"; do
    if [[ ! -f "$required_file" ]]; then
      echo "Missing release artifact: $required_file" >&2
      exit 1
    fi
  done
  hdiutil verify "$dmg_file"

  extraction_dir="$(mktemp -d "/private/tmp/swob-release-${arch}.XXXXXX")"
  trap 'rm -rf "$extraction_dir"' EXIT
  ditto -x -k "$zip_file" "$extraction_dir"
  expected_binary_arch="$arch"
  if [[ "$arch" == "x64" ]]; then expected_binary_arch="x86_64"; fi
  "$script_dir/verify-signed-app.sh" \
    "$extraction_dir/Swob.app" \
    "$expected_version" \
    "$expected_channel" \
    "$expected_team_id" \
    "$expected_binary_arch"
  rm -rf "$extraction_dir"
  trap - EXIT
done

node "$script_dir/assert-release-assets.mjs" \
  --dir "$release_dir" \
  --version "$expected_version" \
  --channel "$expected_channel"

echo "All macOS release artifacts passed fail-closed verification."
