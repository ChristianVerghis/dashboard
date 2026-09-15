#!/usr/bin/env bash
# Start the dashboard on http://localhost:8765
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  ./.venv/bin/python -m pip install -q --upgrade pip
  ./.venv/bin/python -m pip install -q -r requirements.txt
fi

PORT="${PORT:-8765}"

# Rotation guard: launchd redirects stdout here with no rotation — this file
# once hit 26 GB of access-log + error spam. Keep a bounded tail and truncate.
LAUNCHD_LOG="logs/launchd.out.log"
MAX_BYTES=$((200 * 1024 * 1024))  # 200 MB
if [ -f "$LAUNCHD_LOG" ]; then
  size=$(stat -f%z "$LAUNCHD_LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_BYTES" ]; then
    tail -c 5000000 "$LAUNCHD_LOG" > "${LAUNCHD_LOG}.1" 2>/dev/null || true
    : > "$LAUNCHD_LOG"
    echo "rotated ${LAUNCHD_LOG} (${size} bytes > ${MAX_BYTES})"
  fi
fi

echo "starting dashboard on http://localhost:${PORT}"
exec ./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "${PORT}" --no-access-log "$@"
