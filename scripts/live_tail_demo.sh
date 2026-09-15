#!/usr/bin/env bash
# Streams a fake event sequence to the dashboard's live log pane.
# Open http://localhost:8765 first, then run this to watch lines appear.
set -euo pipefail
LOG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/logs/feed.log"
echo "tailing into $LOG"
for msg in \
  "> dashboard live tail demo started" \
  "checking service health..." \
  "  3 services up, 0 down" \
  "  3 routines scheduled" \
  "checking freshness probes..." \
  "  2 amber, 0 red" \
  "all good. demo complete."
do
  echo "$(date '+%H:%M:%S') $msg" >> "$LOG"
  sleep 1
done
