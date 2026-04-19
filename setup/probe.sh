#!/bin/bash
# Wrapper for setup/probe.mjs so /new-setup's inline `!` block is a single
# shell command (permission-check friendly). When Node isn't installed yet,
# emit an "unavailable" status block so the skill's flow knows to skip the
# probe's skip-if conditions and run every step from 1.
set -u

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v node >/dev/null 2>&1; then
  exec node "$PROJECT_ROOT/setup/probe.mjs" "$@"
fi

cat <<'EOF'
=== NANOCLAW SETUP: PROBE ===
STATUS: unavailable
REASON: node_not_installed
=== END ===
EOF
