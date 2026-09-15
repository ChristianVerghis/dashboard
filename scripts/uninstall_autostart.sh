#!/usr/bin/env bash
# Remove the macOS launch agent.
set -euo pipefail

TARGET="${HOME}/Library/LaunchAgents/com.christian.projectsdashboard.plist"
launchctl unload "$TARGET" 2>/dev/null || true
rm -f "$TARGET"
echo "removed: $TARGET"
