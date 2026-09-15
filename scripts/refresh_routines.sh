#!/usr/bin/env bash
# Refresh data/routines_snapshot.json from the live Claude Code Routines API.
# Requires the user to have the claude.ai session cookie active. For now,
# easiest path: run from inside Claude Code with the /schedule skill,
# which has access to RemoteTrigger. The script below is a placeholder
# documenting the manual flow.
set -euo pipefail
echo "Open Claude Code, type:  /schedule list"
echo "Then ask: 'rewrite ./data/routines_snapshot.json with the current routine list'"
echo ""
echo "Future: when /api/code/triggers exposes a public token-auth path,"
echo "this script will curl it directly with \$ANTHROPIC_API_KEY."
