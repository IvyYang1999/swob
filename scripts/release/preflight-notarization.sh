#!/bin/bash
set -euo pipefail

for required_name in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  if [[ -z "${!required_name:-}" ]]; then
    echo "Required Apple notarization credential is missing: ${required_name}" >&2
    exit 1
  fi
done

expected_team_id="${EXPECTED_APPLE_TEAM_ID:-ZPTA4LP594}"
if [[ "$APPLE_TEAM_ID" != "$expected_team_id" ]]; then
  echo 'Apple Team ID does not match the pinned Swob release trust root.' >&2
  exit 1
fi

# Do not enable shell tracing here: the password must never be expanded into logs.
xcrun notarytool history \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --output-format json > /dev/null

echo 'Apple notarization credentials accepted.'
