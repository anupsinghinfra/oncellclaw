#!/usr/bin/env bash
#
# migrate-v2-reset.sh — Wipe v2 migration state back to clean.
#
# For development iteration:
#   bash migrate-v2-reset.sh && bash migrate-v2.sh
#
# What it removes:
#   - data/          (v2 DBs, session state)
#   - logs/          (migration + setup logs)
#   - .env           (merged env keys)
#   - groups/*/      (non-git group folders copied from v1)
#
# What it restores:
#   - groups/global/CLAUDE.md and groups/main/CLAUDE.md from git
#
# What it does NOT touch:
#   - node_modules/  (expensive to reinstall, keep it)
#   - The v1 install (read-only, never modified)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
dim()   { use_ansi && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
green() { use_ansi && printf '\033[32m%s\033[0m' "$1" || printf '%s' "$1"; }

clean() {
  local target=$1 label=$2
  if [ -e "$target" ]; then
    rm -rf "$target"
    printf '%s  Removed %s\n' "$(green '✓')" "$label"
  fi
}

echo
printf '%s\n\n' "$(dim 'Resetting v2 migration state…')"

clean "data"  "data/"
clean "logs"  "logs/"
clean ".env"  ".env"

# Remove all group folders, then restore the two git-tracked ones
if [ -d "groups" ]; then
  rm -rf groups
  printf '%s  Removed %s\n' "$(green '✓')" "groups/"
fi
git checkout -- groups/ 2>/dev/null || true
printf '%s  Restored %s\n' "$(green '✓')" "groups/ from git"

# Restore container/skills/ to git state (remove v1-copied skills)
git checkout -- container/skills/ 2>/dev/null || true
# Remove any untracked skill dirs that were copied from v1
for d in container/skills/*/; do
  [ -d "$d" ] || continue
  if ! git ls-files --error-unmatch "$d" >/dev/null 2>&1; then
    rm -rf "$d"
  fi
done
printf '%s  Restored %s\n' "$(green '✓')" "container/skills/ from git"

# Restore channel code (src/channels/) to git state
git checkout -- src/channels/ 2>/dev/null || true
printf '%s  Restored %s\n' "$(green '✓')" "src/channels/ from git"

echo
printf '%s\n\n' "$(dim 'Clean. Run: bash migrate-v2.sh')"
