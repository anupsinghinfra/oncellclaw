#!/usr/bin/env bash
#
# Install the Codex agent provider non-interactively: copy the payload from the
# `providers` branch, wire the three provider barrels, and pin the Codex CLI in
# the Dockerfile. The image rebuild is the caller's job (the setup container
# step / `./container/build.sh`).
#
# Emits exactly one status block on stdout (ADD_CODEX); all chatty progress
# goes to stderr. Keep in sync with .claude/skills/add-codex/SKILL.md.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with the providers-branch Dockerfile and add-codex SKILL.md.
CODEX_VERSION="0.138.0"

# Resolve the remote carrying the providers branch (same nanoclaw remote that
# carries channels — handles forks where it isn't `origin`).
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
REMOTE=$(resolve_channels_remote)
BRANCH="${REMOTE}/providers"

# The codex payload — host provider, container runtime, setup module, doctrine.
# Barrels are appended to, not copied.
PAYLOAD_FILES=(
  src/providers/codex.ts
  src/providers/codex-agents-md.ts
  src/providers/codex-registration.test.ts
  src/providers/codex-host-contribution.test.ts
  src/providers/codex-agents-md.test.ts
  container/agent-runner/src/providers/codex.ts
  container/agent-runner/src/providers/codex-app-server.ts
  container/agent-runner/src/providers/exchange-archive.ts
  container/agent-runner/src/providers/exchange-archive.test.ts
  container/agent-runner/src/providers/codex-registration.test.ts
  container/agent-runner/src/providers/codex.factory.test.ts
  container/agent-runner/src/providers/codex.turns.test.ts
  container/agent-runner/src/providers/codex-app-server.test.ts
  container/agent-runner/src/providers/codex-dockerfile.test.ts
  setup/providers/codex.ts
  setup/providers/codex.test.ts
  setup/providers/codex-registration.test.ts
  container/AGENTS.md
)
BARRELS=(
  src/providers/index.ts
  container/agent-runner/src/providers/index.ts
  setup/providers/index.ts
)

ALREADY_INSTALLED=true
emit_status() {
  local status=$1 error=${2:-}
  echo "=== NANOCLAW SETUP: ADD_CODEX ==="
  echo "STATUS: ${status}"
  echo "CODEX_VERSION: ${CODEX_VERSION}"
  echo "ALREADY_INSTALLED: ${ALREADY_INSTALLED}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}
log() { echo "[add-codex] $*" >&2; }

# Idempotent: a complete install has the host provider file, the host barrel
# import, and the Dockerfile pin. Any missing → (re)install.
need_install() {
  [ ! -f src/providers/codex.ts ] && return 0
  ! grep -q "^import './codex.js';" src/providers/index.ts 2>/dev/null && return 0
  ! grep -q '@openai/codex@' container/Dockerfile 2>/dev/null && return 0
  return 1
}

if need_install; then
  ALREADY_INSTALLED=false

  log "Fetching providers branch from ${REMOTE}…"
  git fetch "$REMOTE" providers >&2 2>/dev/null || {
    emit_status failed "git fetch ${REMOTE} providers failed"
    exit 1
  }

  log "Copying Codex payload from ${BRANCH}…"
  for f in "${PAYLOAD_FILES[@]}"; do
    mkdir -p "$(dirname "$f")"
    git show "${BRANCH}:$f" > "$f" 2>/dev/null || {
      emit_status failed "providers branch is missing ${f}"
      exit 1
    }
  done

  log "Wiring provider barrels…"
  for b in "${BARRELS[@]}"; do
    grep -q "^import './codex.js';" "$b" || printf "import './codex.js';\n" >> "$b"
  done

  log "Pinning Codex CLI in the Dockerfile…"
  DF=container/Dockerfile
  if ! grep -q "^ARG CODEX_VERSION=" "$DF"; then
    # Version ARG ahead of the first ARG in the version-args block.
    awk -v ins="ARG CODEX_VERSION=${CODEX_VERSION}" \
      'add!=1 && /^ARG /{print ins; add=1} {print}' "$DF" > "$DF.tmp" && mv "$DF.tmp" "$DF"
  fi
  if ! grep -q '@openai/codex@' "$DF"; then
    # Install RUN block (its own cache layer) before the ncl CLI wrapper anchor.
    awk 'add!=1 && /# ---- ncl CLI wrapper/ {
           print "RUN --mount=type=cache,target=/root/.cache/pnpm \\"
           print "    pnpm install -g \"@openai/codex@${CODEX_VERSION}\""
           print ""
           add=1
         } {print}' "$DF" > "$DF.tmp" && mv "$DF.tmp" "$DF"
  fi
fi

emit_status ok
