#!/usr/bin/env bash
# Sends scripts/sample.json to an ingest endpoint with a fresh timestamp and a fresh batch id.
#
#   BASE_URL=http://localhost:3000 BOARD_ID=<uuid> BOARD_KEY=<key> ./scripts/post-sample.sh
#   ./scripts/post-sample.sh same-batch     # reuse the last batch id: simulates a retry
set -euo pipefail
: "${BASE_URL:?set BASE_URL}" "${BOARD_ID:?set BOARD_ID}" "${BOARD_KEY:?set BOARD_KEY}"

dir="$(cd "$(dirname "$0")" && pwd)"
state="${TMPDIR:-/tmp}/aina-last-batch-id"
if [ "${1:-}" = "same-batch" ] && [ -f "$state" ]; then
  batch_id="$(cat "$state")"
else
  # uuidgen exists on macOS; fall back to node on machines without it
  if command -v uuidgen >/dev/null 2>&1; then batch_id="$(uuidgen | tr 'A-Z' 'a-z')"
  else batch_id="$(node -e 'console.log(crypto.randomUUID())')"; fi
  echo "$batch_id" > "$state"
fi
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"   # -u = UTC, Z = say so explicitly (the API rejects timestamps without a zone)

sed -e "s/__NOW__/$now/g" -e "s/6f1c0b0e-6e4e-4a53-9a3f-0f6a1d1d2b11/$batch_id/" "$dir/sample.json" |
  curl -sS -i -X POST "$BASE_URL/api/ingest" \
    -H "X-Board-Id: $BOARD_ID" \
    -H "Authorization: Bearer $BOARD_KEY" \
    -H "Content-Type: application/json" \
    --data-binary @-
echo
