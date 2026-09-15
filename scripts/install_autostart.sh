#!/usr/bin/env bash
# Install the dashboard as a macOS launch agent (starts at login, restarts on crash).
# Run once. To uninstall, see uninstall_autostart.sh.
#
# The plist in scripts/ is a template: __DASHBOARD_DIR__ and __HOME__ are
# substituted with this checkout's absolute path and $HOME (launchd needs
# absolute paths).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="${DIR}/scripts/com.christian.projectsdashboard.plist"
TARGET="${HOME}/Library/LaunchAgents/com.christian.projectsdashboard.plist"

if [ ! -f "$PLIST" ]; then
  echo "missing source plist at $PLIST"
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${DIR}/logs"
sed -e "s|__DASHBOARD_DIR__|${DIR}|g" -e "s|__HOME__|${HOME}|g" "$PLIST" > "$TARGET"
launchctl unload "$TARGET" 2>/dev/null || true
launchctl load "$TARGET"

echo "installed: $TARGET"
echo "the dashboard will now start automatically at login on http://localhost:8765"
echo "logs: $DIR/logs/launchd.{out,err}.log"
