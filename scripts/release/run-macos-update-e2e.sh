#!/bin/bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 5 ]]; then
  echo "Usage: $0 <installed Swob.app> <target-version> <team-id> [stable-channel] [timeout-seconds]" >&2
  exit 2
fi

base_app="$1"
target_version="$2"
expected_team_id="$3"
stable_channel="${4:-swob-signed}"
timeout_seconds="${5:-900}"
script_dir="$(cd "$(dirname "$0")" && pwd)"

if pgrep -x Swob > /dev/null 2>&1; then
  echo "Swob is already running. Stop it before the dedicated update E2E." >&2
  exit 1
fi

base_version="$(plutil -extract CFBundleShortVersionString raw "$base_app/Contents/Info.plist")"
node "$script_dir/assert-release-version.mjs" --from "$base_version" --to "$target_version"
architectures="$(lipo -archs "$base_app/Contents/MacOS/Swob")"
base_arch="arm64"
if grep -qw x86_64 <<< "$architectures" && ! grep -qw arm64 <<< "$architectures"; then base_arch="x86_64"; fi

"$script_dir/verify-signed-app.sh" \
  "$base_app" \
  "$base_version" \
  "$stable_channel" \
  "$expected_team_id" \
  "$base_arch" \
  published-predecessor

e2e_dir="$(mktemp -d /private/tmp/swob-update-e2e.XXXXXX)"
trap 'rm -rf "$e2e_dir"' EXIT
result_file="$e2e_dir/result.json"
log_file="$e2e_dir/swob.log"

SWOB_UPDATE_E2E=1 \
SWOB_UPDATE_E2E_TARGET_VERSION="$target_version" \
SWOB_UPDATE_E2E_CHANNEL=swob-canary \
SWOB_UPDATE_E2E_RESULT_FILE="$result_file" \
  "$base_app/Contents/MacOS/Swob" > "$log_file" 2>&1 &

deadline=$((SECONDS + timeout_seconds))
while [[ ! -f "$result_file" && $SECONDS -lt $deadline ]]; do
  sleep 2
done

if [[ ! -f "$result_file" ]]; then
  echo "Timed out waiting for Swob update E2E result." >&2
  tail -80 "$log_file" >&2 || true
  exit 1
fi

result_state="$(node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(value.result || '')" "$result_file")"
if [[ "$result_state" != "passed" ]]; then
  echo "Swob update E2E failed:" >&2
  node -e "const fs=require('fs'); console.error(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],'utf8')), null, 2))" "$result_file"
  tail -80 "$log_file" >&2 || true
  exit 1
fi

installed_version="$(plutil -extract CFBundleShortVersionString raw "$base_app/Contents/Info.plist")"
if [[ "$installed_version" != "$target_version" ]]; then
  echo "Update E2E reported success but installed version is $installed_version." >&2
  exit 1
fi

"$script_dir/verify-signed-app.sh" \
  "$base_app" \
  "$target_version" \
  "$stable_channel" \
  "$expected_team_id" \
  "$base_arch"

echo "Real macOS update E2E passed: ${base_version} -> ${target_version}."
