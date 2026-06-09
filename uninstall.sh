#!/usr/bin/env bash
#
# uninstall.sh — Safely remove a NanoClaw installation from this computer.
#
# Everything NanoClaw creates is tagged with a per-checkout "install id"
# (sha1(PROJECT_ROOT)[:8]), so several copies can live on one machine. This
# script removes ONLY things belonging to THIS copy. Other copies and shared
# tools (the OneCLI app/vault, your shell PATH line, host-wide config) are
# left alone and listed at the end.
#
# It first checks what actually exists, then — for each group that has
# something to remove — shows a table of exactly what will be deleted and
# asks you to confirm. Groups with nothing are skipped. If nothing is found
# at all, it says so and exits. Nothing is removed until you type "y".
#
#   bash uninstall.sh            # interactive — confirm each group that has something
#   bash uninstall.sh --dry-run  # just show what would be deleted, change nothing
#   bash uninstall.sh --yes      # delete everything found without asking (full wipe)
#   bash uninstall.sh --help
#
set -euo pipefail

# --- resolve project root (the dir this script lives in) --------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
cd "$PROJECT_ROOT"

# Slug helpers must hash the same root that setup used (it runs from the
# project root), so export it explicitly for the helper.
export NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT"
# shellcheck source=setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"

SLUG="$(_nanoclaw_install_slug)"
LABEL="$(launchd_label)"              # com.nanoclaw-v2-<slug>
UNIT="$(systemd_unit)"                # nanoclaw-v2-<slug>
IMAGE_BASE="$(container_image_base)"  # nanoclaw-agent-v2-<slug>
IMAGE="${IMAGE_BASE}:latest"
INSTALL_LABEL="nanoclaw-install=${SLUG}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

HOME_DIR="${HOME:-$(echo ~)}"
OS="$(uname -s)"

# --- flags ------------------------------------------------------------------
DRY_RUN=0
ASSUME_YES=0

usage() { sed -n '3,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) DRY_RUN=1 ;;
    -y|--yes)     ASSUME_YES=1 ;;
    -h|--help)    usage ;;
    *) echo "Unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# --- colors -----------------------------------------------------------------
c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_red=$'\033[31m'; c_grn=$'\033[32m'
c_yel=$'\033[33m'; c_cyn=$'\033[36m'; c_rst=$'\033[0m'
if [ ! -t 1 ]; then c_bold=; c_dim=; c_red=; c_grn=; c_yel=; c_cyn=; c_rst=; fi

have_cmd() { command -v "$1" >/dev/null 2>&1; }
tilde() { case "$1" in "$HOME_DIR"*) printf '~%s' "${1#"$HOME_DIR"}";; *) printf '%s' "$1";; esac; }

# --- table buffer -----------------------------------------------------------
# A scan_* fn fills ROWS with the items it FOUND (only found items — absent
# things are not listed, since we already skip empty groups). FOUND is the
# count for the current group.
ROWS=()
FOUND=0
reset_rows() { ROWS=(); FOUND=0; }
row() { ROWS+=("$1"$'\t'"$2"); FOUND=$((FOUND + 1)); return 0; }  # what, where
group_head() {
  printf '\n%s%s%s\n' "$c_bold" "$1" "$c_rst"
  printf '%s%s%s\n' "$c_dim" "$2" "$c_rst"
}

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '\n  %s%s%s [y/N] ' "$c_yel" "$1" "$c_rst"
  local ans=""; read -r ans </dev/tty 2>/dev/null || ans=""
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

SKIPPED_NOTES=()
note_skip() { SKIPPED_NOTES+=("$1"); }

list_containers() {
  have_cmd "$CONTAINER_RUNTIME" || { echo ""; return; }
  "$CONTAINER_RUNTIME" ps -aq --filter "label=${INSTALL_LABEL}" 2>/dev/null || echo ""
}

# ===========================================================================
# Scanners — fill ROWS with only the items that EXIST for this copy.
# ===========================================================================
scan_service() {
  reset_rows
  case "$OS" in
    Darwin)
      local plist="$HOME_DIR/Library/LaunchAgents/${LABEL}.plist"
      [ -f "$plist" ] && row "Background service" "$(tilde "$plist")"
      ;;
    Linux)
      local uu="$HOME_DIR/.config/systemd/user/${UNIT}.service"
      local us="/etc/systemd/system/${UNIT}.service"
      [ -f "$uu" ] && row "Background service" "$(tilde "$uu")"
      [ -f "$us" ] && row "Background service (system)" "$us"
      [ -f "$PROJECT_ROOT/nanoclaw.pid" ] && row "Running process" "nanoclaw.pid"
      ;;
  esac
  local cids; cids="$(list_containers)"
  [ -n "$cids" ] && row "Running containers" "$(echo "$cids" | wc -l | tr -d ' ') container(s)"
  if have_cmd "$CONTAINER_RUNTIME" && "$CONTAINER_RUNTIME" image inspect "$IMAGE" >/dev/null 2>&1; then
    row "Docker image" "$IMAGE"
  fi
  local link="$HOME_DIR/.local/bin/ncl"
  [ -L "$link" ] && row "Command-line tool (ncl)" "$(tilde "$link")"
  return 0
}

scan_data() {
  reset_rows
  [ -e "$PROJECT_ROOT/data" ]         && row "Database & conversations" "$(tilde "$PROJECT_ROOT/data")/"
  [ -e "$PROJECT_ROOT/logs" ]         && row "Logs" "$(tilde "$PROJECT_ROOT/logs")/"
  [ -e "$PROJECT_ROOT/dist" ]         && row "Build output" "$(tilde "$PROJECT_ROOT/dist")/"
  [ -e "$PROJECT_ROOT/node_modules" ] && row "Installed dependencies" "$(tilde "$PROJECT_ROOT/node_modules")/"
  [ -e "$PROJECT_ROOT/.env" ]         && row "Secrets / API keys (.env)" "backed up before removal"
  [ -e "$PROJECT_ROOT/start-nanoclaw.sh" ] && row "Start script" "start-nanoclaw.sh"
  return 0
}

scan_user() {
  reset_rows
  [ -e "$PROJECT_ROOT/groups" ] && row "Agent memory & files" "$(tilde "$PROJECT_ROOT/groups")/"
  [ -e "$PROJECT_ROOT/store" ]  && row "Migrated data store" "$(tilde "$PROJECT_ROOT/store")/"
  return 0
}

# OneCLI agents fall into two sets, computed once by scan_onecli and reused by
# the dry-run preview, the group-4 decision, and do_onecli. Each entry is
# "<internal-uuid>\t<identifier>\t<name>" — deletion is BY UUID (the identifier,
# i.e. the agent-group id, is NOT a valid --id; see container-runner.ts).
ONECLI_MINE=()      # vault agents whose identifier IS in this copy's data/v2.db
ONECLI_ORPHANS=()   # ag-* vault agents NOT in our DB (maybe another copy's)
ONECLI_DELETE=()    # resolved set to actually delete (filled by decide_onecli)

scan_onecli() {
  reset_rows
  ONECLI_MINE=()
  ONECLI_ORPHANS=()

  have_cmd onecli || return 0

  # Build the vault map once: identifier<TAB>uuid<TAB>name for non-default agents.
  local vault=""
  if have_cmd jq; then
    vault="$(onecli agents list 2>/dev/null \
      | jq -r '.data[] | select(.isDefault|not) | select(.identifier != "default") | "\(.identifier)\t\(.id)\t\(.name)"' 2>/dev/null)" || vault=""
  elif have_cmd python3; then
    vault="$(onecli agents list 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for a in d.get("data", []):
    if a.get("isDefault"):
        continue
    ident = a.get("identifier", "")
    if ident == "default":
        continue
    print("\t".join([ident, a.get("id", ""), a.get("name", "")]))
' 2>/dev/null)" || vault=""
  else
    note_skip "OneCLI agents: need 'jq' or 'python3' to read the vault; list/remove manually with 'onecli agents list' / 'onecli agents delete --id <uuid>'."
    return 0
  fi

  [ -z "$vault" ] && return 0

  # Our agent-group ids from the local DB (present during a normal uninstall,
  # since OneCLI cleanup runs before do_data wipes data/). Newline-delimited so
  # we can do a membership test without bash-4 associative arrays.
  #
  # Prefer the in-tree query wrapper (goes through better-sqlite3, which setup
  # always installs) over the sqlite3 CLI (which setup deliberately avoids
  # depending on — see setup/verify.ts). ids_known distinguishes "this copy has
  # zero agent groups" from "we couldn't read the DB at all"; without it, a
  # missing sqlite3 would mislabel every ag-* agent as an orphan and --yes would
  # silently leave this copy's agents behind.
  local our_ids="" ids_known=0
  if [ -f "$PROJECT_ROOT/data/v2.db" ]; then
    if have_cmd pnpm && [ -f "$PROJECT_ROOT/scripts/q.ts" ]; then
      if our_ids="$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM agent_groups;" 2>/dev/null)"; then
        ids_known=1
      else
        our_ids=""
      fi
    fi
    if [ "$ids_known" = "0" ] && have_cmd sqlite3; then
      if our_ids="$(sqlite3 "$PROJECT_ROOT/data/v2.db" "SELECT id FROM agent_groups;" 2>/dev/null)"; then
        ids_known=1
      else
        our_ids=""
      fi
    fi
  fi

  local saw_orphan=0
  local identifier uuid name
  while IFS=$'\t' read -r identifier uuid name; do
    [ -z "$identifier" ] && continue
    [ "$identifier" = "default" ] && continue
    case $'\n'"$our_ids"$'\n' in
      *$'\n'"$identifier"$'\n'*)
        ONECLI_MINE+=("$uuid"$'\t'"$identifier"$'\t'"$name")
        row "OneCLI agent" "$name — $identifier"
        ;;
      *)
        # Not ours. Only treat NanoClaw-style (ag-*) ids as orphans we surface.
        case "$identifier" in
          ag-*)
            saw_orphan=1
            ONECLI_ORPHANS+=("$uuid"$'\t'"$identifier"$'\t'"$name")
            row "OneCLI agent (orphan)" "$name — $identifier"
            ;;
        esac
        ;;
    esac
  done <<<"$vault"

  # If we couldn't read agent_groups, every ag-* agent was forced into the
  # orphan bucket — warn so the user isn't misled and --yes leaving them behind
  # is explained.
  if [ "$ids_known" = "0" ] && [ "$saw_orphan" = "1" ]; then
    note_skip "Couldn't read agent_groups (need pnpm/tsx or sqlite3); OneCLI agents shown as 'orphan' may actually belong to this copy."
  fi

  return 0
}

# ===========================================================================
# Removers
# ===========================================================================
do_service() {
  printf '\n  %sRemoving app & background service...%s\n' "$c_dim" "$c_rst"
  case "$OS" in
    Darwin)
      local plist="$HOME_DIR/Library/LaunchAgents/${LABEL}.plist"
      if [ -f "$plist" ]; then
        launchctl unload "$plist" >/dev/null 2>&1 || true
        rm -f "$plist" && printf '  %s✓%s background service removed\n' "$c_grn" "$c_rst"
      fi
      ;;
    Linux)
      local uu="$HOME_DIR/.config/systemd/user/${UNIT}.service"
      local us="/etc/systemd/system/${UNIT}.service"
      if [ -f "$uu" ]; then
        systemctl --user disable --now "${UNIT}.service" >/dev/null 2>&1 || true
        rm -f "$uu"; systemctl --user daemon-reload >/dev/null 2>&1 || true
        printf '  %s✓%s background service removed\n' "$c_grn" "$c_rst"
      fi
      if [ -f "$us" ]; then
        if [ "$(id -u)" = "0" ]; then
          systemctl disable --now "${UNIT}.service" >/dev/null 2>&1 || true
          rm -f "$us"; systemctl daemon-reload >/dev/null 2>&1 || true
          printf '  %s✓%s system service removed\n' "$c_grn" "$c_rst"
        else
          printf '  %s!%s system service needs root — left in place\n' "$c_yel" "$c_rst"
          note_skip "System service $us — re-run with sudo to remove."
        fi
      fi
      if [ -f "$PROJECT_ROOT/nanoclaw.pid" ]; then
        local oldpid; oldpid="$(cat "$PROJECT_ROOT/nanoclaw.pid" 2>/dev/null || echo "")"
        [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null && kill "$oldpid" 2>/dev/null || true
      fi
      ;;
  esac
  have_cmd pkill && pkill -f "${PROJECT_ROOT}/dist/index.js" 2>/dev/null && \
    printf '  %s✓%s stopped leftover host process\n' "$c_grn" "$c_rst" || true
  if have_cmd "$CONTAINER_RUNTIME"; then
    local cids; cids="$(list_containers)"
    if [ -n "$cids" ]; then
      # shellcheck disable=SC2086
      "$CONTAINER_RUNTIME" rm -f $cids >/dev/null 2>&1 || true
      printf '  %s✓%s removed %s container(s)\n' "$c_grn" "$c_rst" "$(echo "$cids" | wc -l | tr -d ' ')"
    fi
    if "$CONTAINER_RUNTIME" image inspect "$IMAGE" >/dev/null 2>&1; then
      "$CONTAINER_RUNTIME" rmi "$IMAGE" >/dev/null 2>&1 \
        && printf '  %s✓%s removed Docker image\n' "$c_grn" "$c_rst" \
        || printf '  %s!%s could not remove image (in use?)\n' "$c_yel" "$c_rst"
    fi
  else
    note_skip "Containers/image: '$CONTAINER_RUNTIME' not found; remove later with: $CONTAINER_RUNTIME ps -aq --filter label=${INSTALL_LABEL} | xargs -r $CONTAINER_RUNTIME rm -f; $CONTAINER_RUNTIME rmi $IMAGE"
  fi
  local link="$HOME_DIR/.local/bin/ncl"
  if [ -L "$link" ]; then
    local target abs
    target="$(readlink "$link")"
    case "$target" in
      /*) abs="$target" ;;
      *)  abs="$(cd "$(dirname "$link")" && cd "$(dirname "$target")" 2>/dev/null && pwd)/$(basename "$target")" ;;
    esac
    if [ "$abs" = "$PROJECT_ROOT/bin/ncl" ]; then
      rm -f "$link" && printf '  %s✓%s removed ncl command\n' "$c_grn" "$c_rst"
    else
      printf '  %s!%s ncl points to another copy — left in place\n' "$c_yel" "$c_rst"
      note_skip "ncl command $link points to another NanoClaw copy; left untouched."
    fi
  fi
}

# Decide which OneCLI agents to delete. MINE is a single yes/no; ORPHANS get a
# separate, default-No prompt with an explicit cross-copy warning. Under --yes
# we delete MINE but never ORPHANS (orphans require explicit human intent).
# Anything left behind is reported with the exact manual command (delete by uuid).
decide_onecli() {
  ONECLI_DELETE=()
  local entry uuid identifier name

  if [ "${#ONECLI_MINE[@]}" -gt 0 ]; then
    if [ "$ASSUME_YES" = "1" ] || confirm "Delete this copy's ${#ONECLI_MINE[@]} OneCLI agent(s)?"; then
      for entry in "${ONECLI_MINE[@]}"; do ONECLI_DELETE+=("$entry"); done
    else
      note_skip "OneCLI agents (this copy): kept by your choice."
    fi
  fi

  if [ "${#ONECLI_ORPHANS[@]}" -gt 0 ]; then
    local keep_orphans=1
    if [ "$ASSUME_YES" = "1" ]; then
      printf '\n  %s%d other NanoClaw-style agent(s) in the vault are not linked to this copy;\n  --yes does NOT delete them (they may belong to another copy).%s\n' \
        "$c_yel" "${#ONECLI_ORPHANS[@]}" "$c_rst"
    else
      printf '\n  %sFound %d other NanoClaw-style agent(s) in the vault not linked to this copy —\n  they may belong to ANOTHER NanoClaw copy on this machine.%s\n' \
        "$c_yel" "${#ONECLI_ORPHANS[@]}" "$c_rst"
      if confirm "Delete them too?"; then
        keep_orphans=0
        for entry in "${ONECLI_ORPHANS[@]}"; do ONECLI_DELETE+=("$entry"); done
      fi
    fi
    if [ "$keep_orphans" = "1" ]; then
      note_skip "OneCLI orphan agents (${#ONECLI_ORPHANS[@]}): left in place — remove manually if they're yours:"
      for entry in "${ONECLI_ORPHANS[@]}"; do
        IFS=$'\t' read -r uuid identifier name <<<"$entry"
        note_skip "    onecli agents delete --id $uuid   # $name — $identifier"
      done
    fi
  fi

  [ "${#ONECLI_DELETE[@]}" -gt 0 ] && DO[3]=1
  return 0
}

do_onecli() {
  printf '\n  %sRemoving OneCLI agents...%s\n' "$c_dim" "$c_rst"
  if ! have_cmd onecli; then
    note_skip "OneCLI agents: 'onecli' not on PATH; remove via 'onecli agents list' / 'onecli agents delete --id <uuid>'."
    return 0
  fi
  [ "${#ONECLI_DELETE[@]}" -gt 0 ] || return 0
  local entry uuid identifier name
  for entry in "${ONECLI_DELETE[@]}"; do
    IFS=$'\t' read -r uuid identifier name <<<"$entry"
    [ -z "$uuid" ] && continue
    if onecli agents delete --id "$uuid" >/dev/null 2>&1; then
      printf '  %s✓%s deleted %s (%s)\n' "$c_grn" "$c_rst" "$name" "$identifier"
    else
      printf '  %s!%s %s already gone\n' "$c_yel" "$c_rst" "$identifier"
    fi
  done
}

do_data() {
  printf '\n  %sRemoving app data, logs & secrets...%s\n' "$c_dim" "$c_rst"
  if [ -f "$PROJECT_ROOT/.env" ]; then
    # Don't clobber an existing backup — fall back to a timestamped name.
    local bak="$PROJECT_ROOT/.env.bak"
    [ -e "$bak" ] && bak="$PROJECT_ROOT/.env.bak.$(date +%Y%m%d-%H%M%S)"
    cp -p "$PROJECT_ROOT/.env" "$bak"
    rm -f "$PROJECT_ROOT/.env"
    printf '  %s✓%s removed .env (backup at %s)\n' "$c_grn" "$c_rst" "$(tilde "$bak")"
  fi
  local p
  for p in data logs dist node_modules start-nanoclaw.sh nanoclaw.pid; do
    [ -e "$PROJECT_ROOT/$p" ] && rm -rf "${PROJECT_ROOT:?}/$p" && printf '  %s✓%s removed %s\n' "$c_grn" "$c_rst" "$p" || true
  done
}

do_user() {
  printf '\n  %sRemoving agent memory & files...%s\n' "$c_dim" "$c_rst"
  local p
  for p in groups store; do
    [ -e "$PROJECT_ROOT/$p" ] && rm -rf "${PROJECT_ROOT:?}/$p" && printf '  %s✓%s removed %s\n' "$c_grn" "$c_rst" "$p" || true
  done
}

# ===========================================================================
# Main
# ===========================================================================
printf '\n%sUninstall NanoClaw%s  (copy id: %s)\n' "$c_bold" "$c_rst" "$SLUG"
printf '%sFolder: %s%s\n' "$c_dim" "$PROJECT_ROOT" "$c_rst"
printf '%sChecking what exists for this copy...%s\n' "$c_dim" "$c_rst"

# Group metadata: title | description | scan fn | remove fn | confirm prompt
G_TITLE=(
  "1) App & background service"
  "2) App data, logs & secrets"
  "3) Your agents' memory & files"
  "4) OneCLI credential agents"
)
G_DESC=(
  "Runs NanoClaw in the background. Removing this stops the assistant. None of your data lives here."
  "Message database, conversation history, logs, build files, and your .env (API keys / tokens). Removing this erases stored conversations and saved credentials."
  "Notes and memory your agents created (groups/) and any migrated data (store/). Content you made — it cannot be recovered after deletion."
  "Per-agent entries this copy registered in the OneCLI vault. The OneCLI app, your credentials, and the gateway are NOT touched."
)
G_SCAN=(scan_service scan_data scan_user scan_onecli)
G_DO=(do_service do_data do_user do_onecli)
G_PROMPT=(
  "Delete the app & background service shown above?"
  "Delete app data, logs & secrets shown above? (erases conversations + API keys)"
  "Delete your agents' memory & files shown above? (cannot be undone)"
  "Delete this copy's OneCLI agents shown above?"
)
# Per-group buffers, captured during the scan pass.
G_ROWS=()      # newline-joined rows per group (tab-separated within a row)
G_FOUND=()     # count per group

TOTAL_FOUND=0
EMPTY_LIST=""
for i in 0 1 2 3; do
  "${G_SCAN[$i]}"
  G_FOUND[$i]=$FOUND
  # serialize ROWS (may be empty)
  if [ "$FOUND" -gt 0 ]; then
    G_ROWS[$i]="$(printf '%s\n' "${ROWS[@]}")"
    TOTAL_FOUND=$((TOTAL_FOUND + FOUND))
  else
    G_ROWS[$i]=""
    EMPTY_LIST="${EMPTY_LIST:+$EMPTY_LIST, }${G_TITLE[$i]}"
  fi
done

# Nothing at all → already clean.
if [ "$TOTAL_FOUND" -eq 0 ]; then
  printf '\n%s✓ Nothing to uninstall — this copy (%s) is already clean.%s\n' "$c_grn" "$SLUG" "$c_rst"
  printf '%s  (No service, containers, image, data, or OneCLI agents found for this folder.)%s\n' "$c_dim" "$c_rst"
  exit 0
fi

# Helper to print a group's buffered table.
print_buffered() { # index
  local i="$1"
  group_head "${G_TITLE[$i]}" "${G_DESC[$i]}"
  printf '    %s%-26s %s%s\n' "$c_dim" "WHAT" "WHERE" "$c_rst"
  local what where line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    IFS=$'\t' read -r what where <<<"$line"
    printf '    %s●%s %-26s %s\n' "$c_red" "$c_rst" "$what" "$where"
  done <<<"${G_ROWS[$i]}"
}

# --- dry run: show only groups that have something, then exit ---------------
if [ "$DRY_RUN" = "1" ]; then
  printf '\n%sPREVIEW ONLY — this shows what would be deleted and changes nothing.%s\n' "$c_cyn" "$c_rst"
  for i in 0 1 2 3; do
    [ "${G_FOUND[$i]}" -gt 0 ] || continue
    # Group 3 (OneCLI) mixes MINE and orphan rows; print_buffered would show
    # orphans inside the same "would be deleted" table, contradicting the note
    # that orphans are never auto-deleted. Render the two subsets separately to
    # match the interactive/--yes path (decide_onecli).
    if [ "$i" = "3" ]; then
      group_head "${G_TITLE[3]}" "${G_DESC[3]}"
      printf '    %sWould be deleted (after confirmation):%s\n' "$c_dim" "$c_rst"
      for entry in "${ONECLI_MINE[@]:-}"; do
        [ -n "$entry" ] || continue
        IFS=$'\t' read -r uuid identifier name <<<"$entry"
        printf '    %s●%s %s — %s\n' "$c_red" "$c_rst" "$name" "$identifier"
      done
      printf '    %sLeft in place — may belong to another copy:%s\n' "$c_dim" "$c_rst"
      for entry in "${ONECLI_ORPHANS[@]:-}"; do
        [ -n "$entry" ] || continue
        IFS=$'\t' read -r uuid identifier name <<<"$entry"
        printf '    %s○%s %s — %s\n' "$c_yel" "$c_rst" "$name" "$identifier"
      done
    else
      print_buffered "$i"
    fi
  done
  if [ -n "$EMPTY_LIST" ]; then
    printf '\n%sNothing found for: %s%s\n' "$c_dim" "$EMPTY_LIST" "$c_rst"
  fi
  # Surface scan-time notes (e.g. the M3 "couldn't read agent_groups" warning)
  # here too — dry-run exits before the closing summary that normally prints
  # them, and the whole point is to warn the user before they decide.
  for n in "${SKIPPED_NOTES[@]:-}"; do [ -n "$n" ] && printf '%s  • %s%s\n' "$c_dim" "$n" "$c_rst"; done
  printf '\n%sPreview complete. Nothing was changed.%s\n' "$c_cyn" "$c_rst"
  exit 0
fi

if [ "$ASSUME_YES" = "1" ]; then
  printf '\n%s--yes given: deleting everything found below without asking.%s\n' "$c_yel" "$c_rst"
else
  printf '\n%sYou will be asked about each group that has something. Default is to keep\n(just press Enter). Type "y" to delete a group.%s\n' "$c_dim" "$c_rst"
fi

# --- interactive / --yes: only groups with something ------------------------
DO=(0 0 0 0)
for i in 0 1 2 3; do
  [ "${G_FOUND[$i]}" -gt 0 ] || continue
  print_buffered "$i"
  # Group 4 (OneCLI) has two sub-decisions (this copy's agents vs. orphans) that
  # the single-prompt loop can't express, so it's special-cased.
  if [ "$i" = "3" ]; then
    decide_onecli
  elif confirm "${G_PROMPT[$i]}"; then
    DO[$i]=1
  else
    note_skip "${G_TITLE[$i]}: kept by your choice."
  fi
done

# Execute. OneCLI deletion (index 3) must run BEFORE data (index 1), which
# removes data/v2.db that the OneCLI step reads.
if [ "${DO[0]}" = "1" ]; then do_service; fi
if [ "${DO[3]}" = "1" ]; then do_onecli;  fi
if [ "${DO[1]}" = "1" ]; then do_data;    fi
if [ "${DO[2]}" = "1" ]; then do_user;    fi

# --- closing summary --------------------------------------------------------
printf '\n%s── Left alone (shared / not ours) ──%s\n' "$c_bold" "$c_rst"
printf '%s  • OneCLI app, vault & credentials: ~/.local/share/onecli, ~/.local/bin/onecli\n' "$c_dim"
printf '  • Host-wide config: ~/.config/nanoclaw/ (mount/sender allowlists)\n'
printf '  • PATH line in ~/.bashrc and ~/.zshrc\n'
printf '  • Other NanoClaw copies on this machine%s\n' "$c_rst"
for n in "${SKIPPED_NOTES[@]:-}"; do [ -n "$n" ] && printf '%s  • %s%s\n' "$c_dim" "$n" "$c_rst"; done

printf '\n%s✓ Done. NanoClaw copy %s has been uninstalled.%s\n' "$c_grn" "$SLUG" "$c_rst"
