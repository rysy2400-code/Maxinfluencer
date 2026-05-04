#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG=/tmp/worklive-e2e.log
ERR=/tmp/worklive-e2e.err
rm -f "$LOG" "$ERR"

SESSION_ID="8c1f433d-80ed-4da5-94fe-1939174503f4"
BASE="${WORK_LIVE_BASE_URL:-http://152.32.185.48}"

curl -sS -N --max-time 180 -H "Accept: text/event-stream" \
  "${BASE}/api/sessions/${SESSION_ID}/work-live" >>"$LOG" 2>>"$ERR" &
CURL_PID=$!
sleep 3

node scripts/insert-e2e-search-task.mjs

echo "--- waiting for worker (up to 150s) ---"
sleep 150
kill "$CURL_PID" 2>/dev/null || true
wait "$CURL_PID" 2>/dev/null || true

echo "=== SSE stderr ==="
cat "$ERR" 2>/dev/null || true
echo "=== event types ==="
grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]+"' "$LOG" 2>/dev/null | sort | uniq -c | sort -nr || true
echo "=== hits: work_note | thinking | screenshot ==="
grep -E 'work_note_keyword_summary|"thinking"|"screenshot"' "$LOG" | head -20 || true
echo "=== last data lines ==="
grep '^data:' "$LOG" | tail -25 || true
