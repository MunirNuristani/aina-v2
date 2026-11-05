#!/usr/bin/env bash
# End-to-end smoke test: the REAL built server talking to a REAL Postgres, driven over HTTP like the ESP32 will.
#
#   cd web && npm run build
#   DATABASE_URL=postgres://... ./scripts/e2e.sh        # database must be migrated and (ideally) empty
#
# Creates its own user/board (bootstrap), so it never touches existing data. Exits non-zero on the first surprise.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL (a migrated database)}"
cd "$(dirname "$0")/.."

PORT="${PORT:-3100}"
BASE="http://localhost:$PORT"
LOG="$(mktemp)"

echo "== bootstrap a throwaway board"
out="$(node scripts/bootstrap.mjs --user "e2e" --board "e2e board")"
BOARD_ID="$(echo "$out" | sed -n 's/^BOARD_ID=//p')"
BOARD_KEY="$(echo "$out" | sed -n 's/^BOARD_KEY=//p')"
[ -n "$BOARD_ID" ] && [ -n "$BOARD_KEY" ] || { echo "bootstrap did not print an id and key"; exit 1; }

echo "== start the built server on :$PORT"
npx next start -p "$PORT" >"$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done

fail() { echo "FAIL: $1"; echo "--- server log"; cat "$LOG"; exit 1; }

# post <label> <expected status> <expected body fragment> <board id> <key> <json body>
post() {
  local label="$1" want_status="$2" want_body="$3" id="$4" key="$5" body="$6" resp status text
  resp="$(curl -sS -w '\n%{http_code}' -X POST "$BASE/api/ingest" \
    -H "X-Board-Id: $id" -H "Authorization: Bearer $key" -H "Content-Type: application/json" --data-binary "$body")"
  status="${resp##*$'\n'}"
  text="${resp%$'\n'*}"
  [ "$status" = "$want_status" ] || fail "$label: expected HTTP $want_status, got $status ($text)"
  case "$text" in *"$want_body"*) ;; *) fail "$label: body '$text' lacks '$want_body'" ;; esac
  echo "ok  $label -> $status $text"
}

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BATCH="$(node -e 'console.log(crypto.randomUUID())')"
payload() { # $1 = batch id, $2 = timestamp
  printf '{"client_batch_id":"%s","firmware_version":"e2e","uptime_s":1,"wifi_rssi":-60,"samples":[
    {"channel":1,"t":"%s","raw":3088,"spread":54},{"channel":2,"t":"%s","raw":2720,"spread":61},
    {"channel":3,"t":"%s","raw":2787,"spread":45},{"channel":4,"t":"%s","raw":3125,"spread":80}]}' "$1" "$2" "$2" "$2" "$2"
}

echo "== health"
curl -fsS "$BASE/api/health" | grep -q '"ok":true' || fail "health did not report ok"
echo "ok  health"

echo "== ingest"
post "first post stores 4"             200 '"inserted":4' "$BOARD_ID" "$BOARD_KEY" "$(payload "$BATCH" "$NOW")"
post "same batch again stores 0"       200 '"inserted":0' "$BOARD_ID" "$BOARD_KEY" "$(payload "$BATCH" "$NOW")"
post "wrong key"                       401 'unauthorized' "$BOARD_ID" "wrong"      "$(payload "$BATCH" "$NOW")"
post "unknown board"                   401 'unauthorized' "00000000-0000-0000-0000-00000000ffff" "$BOARD_KEY" "$(payload "$BATCH" "$NOW")"
post "timestamp without a zone"        400 'invalid_payload' "$BOARD_ID" "$BOARD_KEY" "$(payload "$(node -e 'console.log(crypto.randomUUID())')" "${NOW%Z}")"
post "not json"                        400 'invalid_json' "$BOARD_ID" "$BOARD_KEY" '{oops'

echo "== database really has the rows"
count="$(node -e '
  const { Client } = require("pg");
  (async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const r = await c.query("select count(*)::int as n from readings r join sensors s on s.id = r.sensor_id where s.board_id = $1", [process.argv[1]]);
    console.log(r.rows[0].n);
    await c.end();
  })();
' "$BOARD_ID")"
[ "$count" = "4" ] || fail "expected 4 readings for the e2e board, found $count"
echo "ok  4 readings stored, not 8 (the retry did not double-insert)"

echo "ALL E2E CHECKS PASSED"
