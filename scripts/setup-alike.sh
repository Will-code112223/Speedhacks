#!/usr/bin/env bash
# One-time Alike setup for Speedhacks contributors (macOS or Linux).
# Alike gives every teammate's coding agent (Claude Code, Cursor, Codex, ...)
# a shared memory of decisions and live work. Docs: https://alike.help
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: https://nodejs.org" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  echo "Node.js 18+ is required (found $(node -v))." >&2
  exit 1
fi

# A stale token would pin the installer to the wrong server.
unset ALIKE_BASE_URL ALIKE_TOKEN

cat <<'EOF'
Before continuing:
  1. Sign up at https://alike.network using the team invite link
     (ask in the team chat; it is not stored in this repo).
  2. Optional: pick your sharing level under Settings -> Privacy.
     The default is High Sharing (session summaries and decisions visible
     to the workspace; raw transcripts are never shared).

The installer will detect your agents and print a pairing link.
Open it in the browser where you are signed in and approve it within 10 minutes.
EOF
read -r -p "Press Enter to run the Alike installer... " _

npx --yes @alikeai/setup

echo
echo "Done. Restart your agents, approve the 'alike' MCP server, then ask:"
echo "  \"I'm on branch <your-branch> in Speedhacks. What does Alike know about this work?\""
echo "Problems? Run: npx @alikeai/setup --doctor"
