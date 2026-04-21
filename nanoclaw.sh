#!/usr/bin/env bash
#
# NanoClaw — scripted end-to-end install.
#
# Runs `bash setup.sh` (bootstrap: Node check, pnpm install, native module
# verify), then `pnpm run setup:auto` (environment → container → onecli →
# auth → mounts → service → cli-agent → verify).
#
# Everything that can be scripted runs unattended; the one interactive pause
# is the auth step (browser sign-in or paste token/API key).
#
# Config via env — passed through unchanged:
#   NANOCLAW_SKIP  comma-separated setup:auto step names to skip
#   SECRET_NAME    OneCLI secret name (default: Anthropic)
#   HOST_PATTERN   OneCLI host pattern (default: api.anthropic.com)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

cat <<'EOF'
═══════════════════════════════════════════════════════════════
 NanoClaw scripted setup
═══════════════════════════════════════════════════════════════

Phase 1: bootstrap (Node + pnpm + native modules)

EOF

if ! bash setup.sh; then
  echo
  echo "[nanoclaw.sh] Bootstrap failed. Inspect logs/setup.log and retry." >&2
  exit 1
fi

cat <<'EOF'

═══════════════════════════════════════════════════════════════
 Phase 2: setup:auto
═══════════════════════════════════════════════════════════════

EOF

# exec so signals (Ctrl-C) propagate directly to the child.
exec pnpm run setup:auto
