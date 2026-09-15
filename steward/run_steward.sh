#!/usr/bin/env bash
# Nightly steward: runs `claude -p` against ~/dev with the standing orders in STEWARD.md.
# Invoked by launchd (com.christian.devsteward) at 02:00 local. Safe to run by hand.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(cd "$DIR/.." && pwd)"
DEV="$(cd "$DASH/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"
export STEWARD_DATE="$(date +%Y-%m-%d)"
LOGDIR="$DASH/logs/steward"; mkdir -p "$LOGDIR" "$DASH/data/nightly"
LOG="$LOGDIR/$STEWARD_DATE.log"
LOCK="$LOGDIR/.lock"
MAX_MINUTES="${STEWARD_MAX_MINUTES:-75}"
MODEL="${STEWARD_MODEL:-claude-sonnet-5}"

exec >>"$LOG" 2>&1
echo "[$(date -u +%FT%TZ)] === steward start (model=$MODEL, max=${MAX_MINUTES}m) ==="

if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "another steward run is active (pid $(cat "$LOCK")); exiting"; exit 0
fi
echo $$ >"$LOCK"; trap 'rm -f "$LOCK"' EXIT

# Dashboard must be up for the survey; nudge it if not.
if ! curl -sf -m 5 localhost:8765/api/now >/dev/null; then
  echo "dashboard not responding; kickstarting launchd job"
  launchctl kickstart gui/$(id -u)/com.christian.projectsdashboard 2>&1 || true
  sleep 8
fi

cd "$DEV"
claude -p "$(cat "$DIR/STEWARD.md")" \
  --model "$MODEL" \
  --add-dir "$DEV" \
  --allowedTools "Bash,Read,Edit,Write,Glob,Grep" \
  --max-turns 300 \
  --output-format text &
CPID=$!

# Watchdog: hard stop after MAX_MINUTES so a stuck night can't run into the day.
( sleep $((MAX_MINUTES*60)); if kill -0 $CPID 2>/dev/null; then echo "[$(date -u +%FT%TZ)] watchdog: killing claude after ${MAX_MINUTES}m"; kill $CPID; fi ) &
WPID=$!
wait $CPID; RC=$?
kill $WPID 2>/dev/null; wait $WPID 2>/dev/null

if [ ! -f "$DASH/data/nightly/$STEWARD_DATE.md" ]; then
  printf '# Nightly digest — %s\n\n## Needs the owner\n- Steward run exited rc=%s without writing a digest. See logs/steward/%s.log\n' \
    "$STEWARD_DATE" "$RC" "$STEWARD_DATE" >"$DASH/data/nightly/$STEWARD_DATE.md"
fi
echo "[$(date -u +%FT%TZ)] === steward end rc=$RC ==="
# keep 60 days of logs
find "$LOGDIR" -name '*.log' -mtime +60 -delete 2>/dev/null || true
