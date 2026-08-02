#!/usr/bin/env bash
#
# cloud-start.sh — empty machine → running oncellclaw host, in one command.
#
# This is the whole hosted install. It is what oncell.ai/dashboard/claw runs
# as your cell's service command, and it is a supported way to self-host on
# any box that can reach the internet.
#
# NODE-ONLY BOOTSTRAP: the only tools required are bash, node (>= 18 for
# global fetch; the app itself needs >= 20), tar, and corepack/npm. Cells
# ship exactly that rootfs — no git, no curl, no wget, no python3 — so the
# source arrives as a GitHub tarball fetched by node, not a git clone:
# ONCELLCLAW_REF is resolved to a commit sha via the GitHub API, then
# https://codeload.github.com/{owner}/{repo}/tar.gz/{sha} is downloaded and
# extracted. ONCELLCLAW_REPO/ONCELLCLAW_REF semantics are unchanged.
#
# Layout under $ONCELLCLAW_DIR (the persistent base, default ~/oncellclaw):
#
#   current -> src-<sha>     the running checkout (symlink, flipped atomically)
#   src-<sha>/               immutable source tree for one commit
#   state/                   everything that must survive updates:
#     data/  groups/  store/  .env
#                            (symlinked into each src-<sha> — the app's
#                            data/groups/store paths are cwd-relative)
#   toolchain/               corepack shims + private node if system node
#                            is too old (fetched by node, never curl)
#
# A checkout is a pure function of the sha: same sha already extracted →
# no download at all (fast warm restart); new sha → extracted alongside,
# `current` flipped, old trees pruned only after build+provision succeed.
#
# The port is claimed IMMEDIATELY: service supervisors (the OnCell cell
# supervisor included) probe $PORT shortly after start and kill anything
# that isn't accepting connections — a cold boot spends minutes downloading
# + installing and would never survive that. So right after config
# validation a tiny placeholder HTTP server binds 0.0.0.0:$PORT and answers
# every path with 503 {"ok":false,"phase":"<stage>"} until the real host is
# ready; the dashboard reads `phase` to show honest progress. Just before
# exec the placeholder is killed and the port verified free — the brief
# connection-refused gap reads as "still starting" upstream.
#
# Environment (see README "Hosted (how it works)" for the full table):
#
#   ONCELLCLAW_REPO            GitHub repo URL         (default: this repo)
#   ONCELLCLAW_REF             branch, tag or sha      (default: main)
#   ONCELLCLAW_DIR             persistent base dir     (default: $HOME/oncellclaw)
#   ONCELLCLAW_RUNTIME         oncell | docker         (default: oncell)
#   ONCELL_API_KEY             required when runtime=oncell
#   ONCELL_API_URL             optional API override
#   ANTHROPIC_API_KEY          agent credential  ─┐ exactly one
#   CLAUDE_CODE_OAUTH_TOKEN    agent credential  ─┘ of these
#   ONCELLCLAW_WEB_TOKEN       bearer token for the web channel (required
#                              unless ONCELLCLAW_WEB_ALLOW_INSECURE=1)
#   ONCELLCLAW_WEB_ALLOW_INSECURE=1   run the web channel unauthenticated
#   ONCELLCLAW_GROUP           agent group slug        (default: assistant)
#   ONCELLCLAW_PERSONA         standing instructions   (optional)
#   PORT                       HTTP listen port. The cell supervisor always
#                              sets this; the 3000 fallback exists only for
#                              bare self-hosted runs. Never overridden here.
#
# Credentials are passed through the process environment only. Nothing here
# writes a secret to disk.

set -euo pipefail

ONCELLCLAW_REPO="${ONCELLCLAW_REPO:-https://github.com/anupsinghinfra/oncellclaw.git}"
ONCELLCLAW_REF="${ONCELLCLAW_REF:-main}"
ONCELLCLAW_DIR="${ONCELLCLAW_DIR:-$HOME/oncellclaw}"
ONCELLCLAW_GROUP="${ONCELLCLAW_GROUP:-assistant}"
ONCELLCLAW_RUNTIME="${ONCELLCLAW_RUNTIME:-oncell}"
PORT="${PORT:-3000}"

# Endpoint seams — overridden only by the bootstrap smoke test, which points
# them at a local stub so no test ever touches live GitHub.
ONCELLCLAW_GITHUB_API="${ONCELLCLAW_GITHUB_API:-https://api.github.com}"
ONCELLCLAW_CODELOAD="${ONCELLCLAW_CODELOAD:-https://codeload.github.com}"

BASE="$ONCELLCLAW_DIR"
STATE_DIR="$BASE/state"
TOOLCHAIN_DIR="$BASE/toolchain"
NODE_MAJOR_MIN=20
NODE_MAJOR_INSTALL=22

export ONCELLCLAW_RUNTIME PORT
# No .git directory exists here — husky's prepare hook must not fail the
# install. HUSKY=0 is husky's own documented off-switch.
export HUSKY=0
# corepack: never prompt, and keep its cache with the rest of the toolchain
# so pnpm survives src-<sha> swaps. INTEGRITY_KEYS=0 because npm rotated its
# registry signing keys and the corepack bundled with node ships a stale
# keyset — verification dies with "Cannot find matching keyid" even for
# genuine packages (seen live on cells). Downloads still ride registry TLS,
# and the npm fallback below has no signature check either, so this drops
# no protection this path ever really had.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_HOME="$TOOLCHAIN_DIR/corepack"
export COREPACK_INTEGRITY_KEYS=0

stage_no=0
stage() {
  stage_no=$((stage_no + 1))
  printf '\n==> [%d/7] %s\n' "$stage_no" "$1"
}
info() { printf '    %s\n' "$1"; }
die() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# node-based network primitives — the only way this script touches the
# network. Both fail loudly on HTTP errors.
# ---------------------------------------------------------------------------

# fetch_text URL → body on stdout.
fetch_text() {
  URL="$1" node -e '
    fetch(process.env.URL, {
      headers: { "User-Agent": "oncellclaw-bootstrap", Accept: "application/vnd.github+json" },
    })
      .then(async (r) => {
        if (!r.ok) {
          console.error(`HTTP ${r.status} for ${process.env.URL}`);
          process.exit(1);
        }
        process.stdout.write(await r.text());
      })
      .catch((err) => {
        console.error(`fetch failed for ${process.env.URL}: ${err}`);
        process.exit(1);
      });
  '
}

# fetch_file URL DEST — streamed to disk, not buffered.
fetch_file() {
  URL="$1" DEST="$2" node -e '
    const { createWriteStream } = require("fs");
    const { Readable } = require("stream");
    const { pipeline } = require("stream/promises");
    fetch(process.env.URL, { headers: { "User-Agent": "oncellclaw-bootstrap" } })
      .then(async (r) => {
        if (!r.ok || !r.body) {
          console.error(`HTTP ${r.status} for ${process.env.URL}`);
          process.exit(1);
        }
        await pipeline(Readable.fromWeb(r.body), createWriteStream(process.env.DEST));
      })
      .catch((err) => {
        console.error(`fetch failed for ${process.env.URL}: ${err}`);
        process.exit(1);
      });
  '
}

# ---------------------------------------------------------------------------
# Boot placeholder — binds $PORT within the supervisor's readiness window.
#
# Answers EVERY path with 503 {"ok":false,"phase":"<current>"}, re-reading
# the phase file per request so the dashboard stepper tracks progress. Uses
# the system node (present in the cell rootfs) — this runs long before
# anything is downloaded.
# ---------------------------------------------------------------------------
PHASE_FILE="$(mktemp)"
placeholder_pid=''
persona_file=''
extract_tmp=''

set_phase() { printf '%s' "$1" >"$PHASE_FILE"; }

start_placeholder() {
  PHASE_FILE="$PHASE_FILE" PORT="$PORT" node -e '
    const http = require("http");
    const fs = require("fs");
    const port = Number(process.env.PORT);
    const phaseFile = process.env.PHASE_FILE;
    http
      .createServer((req, res) => {
        let phase = "starting";
        try {
          phase = fs.readFileSync(phaseFile, "utf8").trim() || "starting";
        } catch (err) {
          // phase file gone mid-shutdown — report the default
        }
        const body = JSON.stringify({ ok: false, phase });
        res.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
          "Retry-After": "5",
        });
        res.end(body);
      })
      .listen(port, "0.0.0.0");
  ' &
  placeholder_pid=$!
  info "placeholder bound :${PORT} (pid ${placeholder_pid}) — /health reports the bootstrap phase"
}

stop_placeholder() {
  if [ -n "$placeholder_pid" ]; then
    kill "$placeholder_pid" 2>/dev/null || true
    wait "$placeholder_pid" 2>/dev/null || true
    placeholder_pid=''
  fi
}

# Wait (≤5s) until $PORT accepts a fresh bind, so the real host never races
# the dying placeholder for the socket.
wait_port_free() {
  local i
  for i in $(seq 1 25); do
    if node -e '
      const s = require("net").createServer();
      s.once("error", () => process.exit(1));
      s.listen(Number(process.env.PORT), "0.0.0.0", () => s.close(() => process.exit(0)));
    ' 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  info "WARNING: :${PORT} still busy after 5s — continuing; the host will retry the bind itself"
}

cleanup() {
  stop_placeholder
  rm -f "$PHASE_FILE"
  [ -n "$persona_file" ] && rm -f "$persona_file"
  [ -n "$extract_tmp" ] && rm -rf "$extract_tmp"
  return 0
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Configuration check — fail before doing any work, not halfway through.
# ---------------------------------------------------------------------------
stage 'Checking configuration'

have node || die 'node is required (it is present in every cell rootfs). Install Node >= 20 and re-run.'
have tar || die 'tar is required and was not found.'

if [ "$ONCELLCLAW_RUNTIME" = 'oncell' ] && [ -z "${ONCELL_API_KEY:-}" ]; then
  die "ONCELLCLAW_RUNTIME=oncell but ONCELL_API_KEY is not set. Get a key at https://oncell.ai, or set ONCELLCLAW_RUNTIME=docker to run agents in local Docker."
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  die 'No agent credential: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.'
fi
if [ -z "${ONCELLCLAW_WEB_TOKEN:-}" ] && [ "${ONCELLCLAW_WEB_ALLOW_INSECURE:-}" != '1' ]; then
  die "ONCELLCLAW_WEB_TOKEN is not set. The web channel is this instance's front door and its URL is public — set a long random token (e.g. 64 hex chars), or set ONCELLCLAW_WEB_ALLOW_INSECURE=1 for a trusted local network."
fi
if [ -e "$BASE/.git" ]; then
  die "$BASE is a git checkout. This script owns its base directory (src-<sha>/ + state/ layout) — point ONCELLCLAW_DIR somewhere else, e.g. \$HOME/oncellclaw-hosted."
fi

# Derive owner/repo from the GitHub URL — the tarball endpoints need them.
case "$ONCELLCLAW_REPO" in
  *github.com*) ;;
  *) die "ONCELLCLAW_REPO must be a github.com URL for the tarball bootstrap (got: ${ONCELLCLAW_REPO}). Non-GitHub hosting needs a git-capable environment." ;;
esac
gh_path="${ONCELLCLAW_REPO#*github.com}"
gh_path="${gh_path#?}" # strip the ':' or '/' after the host
gh_path="${gh_path%.git}"
gh_path="${gh_path%/}"
gh_owner="${gh_path%%/*}"
gh_repo="${gh_path#*/}"
if [ -z "$gh_owner" ] || [ -z "$gh_repo" ] || [ "$gh_owner" = "$gh_repo" ] || printf '%s' "$gh_repo" | grep -q '/'; then
  die "could not parse owner/repo from ONCELLCLAW_REPO: ${ONCELLCLAW_REPO}"
fi

info "repo:    github.com/${gh_owner}/${gh_repo} @ ${ONCELLCLAW_REF}"
info "base:    ${BASE}"
info "runtime: ${ONCELLCLAW_RUNTIME}"
info "group:   ${ONCELLCLAW_GROUP}"
info "port:    ${PORT}"
info "auth:    $([ -n "${ONCELLCLAW_WEB_TOKEN:-}" ] && echo 'bearer token' || echo 'DISABLED (insecure flag set)')"

# Claim the port FIRST — everything after this can take minutes, and the
# supervisor's readiness probe won't wait that long.
set_phase 'starting'
start_placeholder

# ---------------------------------------------------------------------------
# 2. Source — resolve the ref to a sha, fetch the tarball, extract, flip.
# ---------------------------------------------------------------------------
stage 'Fetching source'
set_phase 'clone'

mkdir -p "$BASE" "$STATE_DIR/data" "$STATE_DIR/groups" "$STATE_DIR/store"
rm -rf "$BASE"/.extract-* 2>/dev/null || true

# Replace the mutable state dirs inside a checkout with symlinks into
# $STATE_DIR. The app's data/groups/store paths are cwd-relative and not
# env-configurable (src/config.ts), so the links ARE the knob. `rm -rf` on
# an existing symlink removes only the link; on a fresh extraction it
# removes whatever placeholder content the tarball carried.
wire_state() {
  local src_dir="$1" name
  for name in data groups store; do
    rm -rf "${src_dir:?}/${name}"
    ln -s "$STATE_DIR/$name" "$src_dir/$name"
  done
  # .env too: tarballs never contain one (gitignored), but a self-hoster may
  # drop one into state/. A dangling link is fine — readEnvFile treats
  # ENOENT as "no .env".
  rm -f "$src_dir/.env"
  ln -s "$STATE_DIR/.env" "$src_dir/.env"
}

# Resolve ONCELLCLAW_REF → full commit sha. A 40-hex ref IS the sha (no
# network needed — a pinned warm restart boots offline). Anything else asks
# the GitHub API; if that fails but a previous checkout exists, reuse it
# rather than dying — an upstream blip must not take the assistant down.
sha=''
if printf '%s' "$ONCELLCLAW_REF" | grep -qE '^[0-9a-f]{40}$'; then
  sha="$ONCELLCLAW_REF"
  info 'ref is a full sha — no resolution needed'
else
  if sha="$(
    GH_URL="${ONCELLCLAW_GITHUB_API}/repos/${gh_owner}/${gh_repo}/commits/${ONCELLCLAW_REF}" node -e '
      fetch(process.env.GH_URL, {
        headers: { "User-Agent": "oncellclaw-bootstrap", Accept: "application/vnd.github+json" },
      })
        .then(async (r) => {
          if (!r.ok) {
            console.error(`HTTP ${r.status} for ${process.env.GH_URL}`);
            process.exit(1);
          }
          const j = await r.json();
          if (!/^[0-9a-f]{40}$/.test(j.sha || "")) {
            console.error(`no commit sha in API response for ${process.env.GH_URL}`);
            process.exit(1);
          }
          console.log(j.sha);
        })
        .catch((err) => {
          console.error(`fetch failed for ${process.env.GH_URL}: ${err}`);
          process.exit(1);
        });
    '
  )"; then
    info "resolved ${ONCELLCLAW_REF} -> ${sha}"
  elif [ -L "$BASE/current" ] && [ -d "$BASE/current" ]; then
    info "WARNING: could not resolve '${ONCELLCLAW_REF}' — reusing the existing checkout"
    sha=''
  else
    die "could not resolve ref '${ONCELLCLAW_REF}' and no previous checkout exists (see the error above)"
  fi
fi

if [ -n "$sha" ]; then
  SRC="$BASE/src-${sha}"
  if [ -d "$SRC" ]; then
    info "src-${sha} already extracted — skipping download"
  else
    tarball="$(mktemp)"
    info "downloading tarball for ${sha}"
    fetch_file "${ONCELLCLAW_CODELOAD}/${gh_owner}/${gh_repo}/tar.gz/${sha}" "$tarball"
    extract_tmp="$BASE/.extract-$$"
    mkdir -p "$extract_tmp"
    # codeload tarballs wrap everything in a "{repo}-{sha}/" top directory.
    tar -xzf "$tarball" -C "$extract_tmp" --strip-components=1
    rm -f "$tarball"
    [ -f "$extract_tmp/package.json" ] || die 'extracted tarball has no package.json — wrong repo or corrupt download'
    wire_state "$extract_tmp"
    # Atomic publish: a crash before this mv leaves only a .extract-* temp
    # dir (cleaned next run); a concurrent extraction losing the race is
    # discarded in favor of the one that won.
    if ! mv "$extract_tmp" "$SRC" 2>/dev/null; then
      [ -d "$SRC" ] || die "failed to move extracted source into place: ${SRC}"
      rm -rf "$extract_tmp"
    fi
    extract_tmp=''
    info "extracted src-${sha}"
  fi
  wire_state "$SRC" # idempotent re-link — heals a partially wired tree
  ln -sfn "$SRC" "$BASE/current"
fi

cd "$BASE/current"
info "current -> $(basename "$(pwd -P)")"

# Test seam: the bootstrap smoke test stops here — source acquisition is the
# only stage with new network mechanics, and everything after needs a real
# toolchain + registry access.
if [ "${ONCELLCLAW_BOOTSTRAP_ONLY:-}" = 'source' ]; then
  info 'ONCELLCLAW_BOOTSTRAP_ONLY=source — stopping before toolchain'
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Toolchain — system node if new enough, else a private one fetched by
#    node; pnpm via corepack shims (no global installs).
# ---------------------------------------------------------------------------
stage 'Ensuring Node and pnpm'
set_phase 'toolchain'

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_node() {
  local major os arch name url node_tar
  major="$(cat .nvmrc 2>/dev/null || echo "$NODE_MAJOR_INSTALL")"
  case "$(uname -s)" in
    Linux) os='linux' ;;
    Darwin) os='darwin' ;;
    *) die "unsupported OS for automatic Node install: $(uname -s). Install Node >= ${NODE_MAJOR_MIN} and re-run." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch='x64' ;;
    aarch64 | arm64) arch='arm64' ;;
    *) die "unsupported architecture for automatic Node install: $(uname -m). Install Node >= ${NODE_MAJOR_MIN} and re-run." ;;
  esac

  # Resolve the current patch release of that major from the dist checksums —
  # no pinned full version to go stale. .tar.gz (not .tar.xz) so a minimal
  # busybox tar can unpack it. Downloaded by node fetch — never curl.
  name="$(fetch_text "https://nodejs.org/dist/latest-v${major}.x/SHASUMS256.txt" |
    awk -v pat="-${os}-${arch}\\.tar\\.gz$" '$2 ~ pat { print $2; exit }')"
  [ -n "$name" ] || die "could not resolve a Node v${major} build for ${os}-${arch}"
  url="https://nodejs.org/dist/latest-v${major}.x/${name}"

  info "downloading ${name}"
  mkdir -p "$TOOLCHAIN_DIR/node"
  node_tar="$(mktemp)"
  fetch_file "$url" "$node_tar"
  tar -xzf "$node_tar" -C "$TOOLCHAIN_DIR/node" --strip-components=1
  rm -f "$node_tar"
}

if [ -x "${TOOLCHAIN_DIR}/node/bin/node" ]; then
  export PATH="${TOOLCHAIN_DIR}/node/bin:$PATH"
fi
if [ "$(node_major)" -lt "$NODE_MAJOR_MIN" ]; then
  info "system node too old (need >= ${NODE_MAJOR_MIN}) — installing a private one"
  install_node
  export PATH="${TOOLCHAIN_DIR}/node/bin:$PATH"
fi
info "node $(node --version)"

mkdir -p "$TOOLCHAIN_DIR/bin"
export PATH="${TOOLCHAIN_DIR}/bin:$PATH"
# A working pnpm is one that can print its version — a corepack shim can
# exist yet die at runtime (stale bundled keyset, network), so existence is
# not the test.
pnpm_works() { pnpm --version >/dev/null 2>&1; }
if ! pnpm_works && have corepack; then
  # Shims land in the toolchain, not the (possibly read-only) node bin dir.
  # The shim resolves the exact pnpm version from this checkout's
  # packageManager field on first run.
  corepack enable --install-directory "$TOOLCHAIN_DIR/bin" >/dev/null 2>&1 || true
fi
if ! pnpm_works; then
  # corepack absent or its shim broken — remove any dead shims and install
  # via npm (ships with node) into the same prefix.
  rm -f "$TOOLCHAIN_DIR/bin/pnpm" "$TOOLCHAIN_DIR/bin/pnpx"
  pm="$(node -p "(require('./package.json').packageManager||'pnpm@latest')" 2>/dev/null || echo 'pnpm@latest')"
  info "corepack unavailable — installing ${pm} via npm"
  npm install -g --silent --prefix "$TOOLCHAIN_DIR" "$pm" >/dev/null
fi
pnpm_works || die 'pnpm could not be provisioned via corepack or npm.'
info "pnpm $(pnpm --version)"

# ---------------------------------------------------------------------------
# 4+5. Dependencies + build.
# ---------------------------------------------------------------------------
stage 'Installing dependencies'
set_phase 'install'
pnpm install --frozen-lockfile --reporter=append-only
info 'dependencies ready'

stage 'Building'
set_phase 'build'
pnpm build
# The startup tripwire refuses to boot an install that reached its version
# outside a sanctioned path. This script IS that path for a hosted instance,
# so it stamps the marker after a successful build.
pnpm exec tsx scripts/upgrade-state.ts set '' cloud-start >/dev/null
info "built $(node -p "require('./package.json').version")"

# ---------------------------------------------------------------------------
# 6. DB init, migrations, and first-run provisioning. Converges — a restart
#    re-runs this and creates nothing.
# ---------------------------------------------------------------------------
stage 'Provisioning'
set_phase 'provision'

if [ -n "${ONCELLCLAW_PERSONA:-}" ]; then
  persona_file="$(mktemp)" # cleaned by the EXIT trap
  printf '%s\n' "$ONCELLCLAW_PERSONA" >"$persona_file"
  pnpm exec tsx scripts/provision.ts --group "$ONCELLCLAW_GROUP" --persona-file "$persona_file"
  rm -f "$persona_file"
  persona_file=''
else
  pnpm exec tsx scripts/provision.ts --group "$ONCELLCLAW_GROUP"
fi

# ---------------------------------------------------------------------------
# 7. Hand off: prune superseded checkouts, placeholder down, port verified
#    free, exec the host so the supervisor owns the real process. The moment
#    between kill and the host's bind reads as connection-refused upstream —
#    treated as "still starting", unlike a 30s never-bound timeout.
# ---------------------------------------------------------------------------
stage 'Starting host'
set_phase 'handoff'

# Old source trees are only removed HERE — after the new tree has built and
# provisioned successfully — so a failed update never deletes the last
# known-good checkout.
current_real="$(pwd -P)"
for d in "$BASE"/src-*; do
  [ -d "$d" ] || continue
  [ "$d" = "$current_real" ] || rm -rf "$d"
done

# Mirrors normalizeName() — the group slug is what appears in the URL.
group_slug="$(printf '%s' "$ONCELLCLAW_GROUP" | tr '[:upper:]' '[:lower:]' |
  sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-\{1,\}//' -e 's/-\{1,\}$//')"
info "POST /web/${group_slug}/message and GET /web/${group_slug}/messages on :${PORT}"

stop_placeholder
wait_port_free
trap - EXIT
rm -f "$PHASE_FILE"
exec node dist/index.js
