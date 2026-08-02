#!/usr/bin/env bash
#
# cloud-start.sh — empty machine → running oncellclaw host, in one command.
#
# This is the whole hosted install. It is what oncell.ai/dashboard/claw runs
# for you as your cell's service command, and it is a supported way to
# self-host on any Linux box or container that can reach the internet.
#
#   curl -fsSL https://raw.githubusercontent.com/anupsinghinfra/oncellclaw/main/scripts/cloud-start.sh | bash
#
# Stages: toolchain → checkout → deps → build → provision → run. Every one
# of them is idempotent and resumable, because a supervised service is
# restarted, not installed once: a restart fast-forwards the existing
# checkout instead of re-cloning, and provisioning converges on the agent
# group that already exists instead of creating a second one. The process
# ends with `exec`, so the supervisor owns the host process directly (PID 1
# semantics, signals, restart-on-exit).
#
# The port is claimed IMMEDIATELY: service supervisors (the OnCell cell
# supervisor included) probe $PORT shortly after start and kill anything
# that isn't accepting connections — a cold boot spends minutes in clone +
# install and would never survive that. So right after config validation a
# tiny placeholder HTTP server binds 0.0.0.0:$PORT and answers every path
# with 503 {"ok":false,"phase":"<stage>"} until the real host is ready to
# take over; the dashboard reads `phase` to show honest progress. Just
# before exec the placeholder is killed and the port verified free — the
# brief connection-refused gap reads as "still starting" upstream.
#
# Environment (see README "Hosted (how it works)" for the full table):
#
#   ONCELLCLAW_REPO            git URL to run          (default: this repo)
#   ONCELLCLAW_REF             branch, tag or sha      (default: main)
#   ONCELLCLAW_DIR             persistent checkout     (default: $HOME/oncellclaw)
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

TOOLCHAIN_DIR="${ONCELLCLAW_DIR}/.toolchain"
NODE_MAJOR_MIN=20
NODE_MAJOR_INSTALL=22

export ONCELLCLAW_RUNTIME PORT

stage_no=0
stage() {
  stage_no=$((stage_no + 1))
  printf '\n==> [%d/8] %s\n' "$stage_no" "$1"
}
info() { printf '    %s\n' "$1"; }
die() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Boot placeholder — binds $PORT within the supervisor's readiness window.
#
# Answers EVERY path with 503 {"ok":false,"phase":"<current>"}, re-reading
# the phase file per request so the dashboard stepper tracks progress. Uses
# the system node (present in the cell rootfs) — this runs long before the
# private toolchain exists.
# ---------------------------------------------------------------------------
PHASE_FILE="$(mktemp)"
placeholder_pid=''
persona_file=''

set_phase() { printf '%s' "$1" >"$PHASE_FILE"; }

start_placeholder() {
  if ! have node; then
    # No system node: nothing can bind the port this early. Proceed — a warm
    # restart with the toolchain already present reaches exec fast anyway.
    info "WARNING: no system node — cannot bind :${PORT} during bootstrap; a slow cold boot may be killed by the supervisor"
    return 0
  fi
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
  return 0
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Configuration check — fail before doing any work, not halfway through.
# ---------------------------------------------------------------------------
stage 'Checking configuration'

if [ "$ONCELLCLAW_RUNTIME" = 'oncell' ] && [ -z "${ONCELL_API_KEY:-}" ]; then
  die "ONCELLCLAW_RUNTIME=oncell but ONCELL_API_KEY is not set. Get a key at https://oncell.ai, or set ONCELLCLAW_RUNTIME=docker to run agents in local Docker."
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  die 'No agent credential: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.'
fi
if [ -z "${ONCELLCLAW_WEB_TOKEN:-}" ] && [ "${ONCELLCLAW_WEB_ALLOW_INSECURE:-}" != '1' ]; then
  die "ONCELLCLAW_WEB_TOKEN is not set. The web channel is this instance's front door and its URL is public — set a long random token (e.g. \`openssl rand -hex 32\`), or set ONCELLCLAW_WEB_ALLOW_INSECURE=1 for a trusted local network."
fi

info "repo:    ${ONCELLCLAW_REPO} @ ${ONCELLCLAW_REF}"
info "dir:     ${ONCELLCLAW_DIR}"
info "runtime: ${ONCELLCLAW_RUNTIME}"
info "group:   ${ONCELLCLAW_GROUP}"
info "port:    ${PORT}"
info "auth:    $([ -n "${ONCELLCLAW_WEB_TOKEN:-}" ] && echo 'bearer token' || echo 'DISABLED (insecure flag set)')"

# Claim the port FIRST — everything after this can take minutes, and the
# supervisor's readiness probe won't wait that long.
set_phase 'starting'
start_placeholder

# ---------------------------------------------------------------------------
# 2. git — needed before anything else can be fetched.
# ---------------------------------------------------------------------------
stage 'Ensuring git'
set_phase 'toolchain'

install_git() {
  local sudo_cmd=''
  if [ "$(id -u)" -ne 0 ] && have sudo; then sudo_cmd='sudo'; fi
  if have apt-get; then
    $sudo_cmd apt-get update -qq && $sudo_cmd apt-get install -y -qq git
  elif have apk; then
    $sudo_cmd apk add --no-cache git
  elif have dnf; then
    $sudo_cmd dnf install -y -q git
  elif have yum; then
    $sudo_cmd yum install -y -q git
  else
    return 1
  fi
}

if have git; then
  info "git $(git --version | awk '{print $3}')"
else
  info 'git not found — installing'
  install_git >/dev/null 2>&1 || die 'git is required and could not be installed automatically. Install git and re-run.'
  info "git $(git --version | awk '{print $3}')"
fi

# ---------------------------------------------------------------------------
# 3. Checkout — clone once, fast-forward forever after.
# ---------------------------------------------------------------------------
stage 'Syncing checkout'
set_phase 'clone'

if [ -d "${ONCELLCLAW_DIR}/.git" ]; then
  info 'existing checkout — fetching'
  git -C "$ONCELLCLAW_DIR" remote set-url origin "$ONCELLCLAW_REPO"
  git -C "$ONCELLCLAW_DIR" fetch --quiet --prune --tags origin
else
  info 'no checkout — cloning'
  mkdir -p "$(dirname "$ONCELLCLAW_DIR")"
  git clone --quiet "$ONCELLCLAW_REPO" "$ONCELLCLAW_DIR"
fi

# Branch first, then tag/sha. Detached HEAD keeps the checkout a pure
# function of ONCELLCLAW_REF, so there is no local branch to diverge.
target="$(git -C "$ONCELLCLAW_DIR" rev-parse --verify -q "origin/${ONCELLCLAW_REF}^{commit}" 2>/dev/null || true)"
if [ -z "$target" ]; then
  target="$(git -C "$ONCELLCLAW_DIR" rev-parse --verify -q "${ONCELLCLAW_REF}^{commit}" 2>/dev/null || true)"
fi
[ -n "$target" ] || die "ref not found in ${ONCELLCLAW_REPO}: ${ONCELLCLAW_REF}"

# reset --hard only touches TRACKED files. data/, groups/, store/ and .env
# are gitignored, so instance state survives every update.
git -C "$ONCELLCLAW_DIR" checkout --quiet --detach "$target"
git -C "$ONCELLCLAW_DIR" reset --hard --quiet "$target"
info "at $(git -C "$ONCELLCLAW_DIR" rev-parse --short HEAD) (${ONCELLCLAW_REF})"

cd "$ONCELLCLAW_DIR"

# ---------------------------------------------------------------------------
# 4. Node + pnpm. Installed under the checkout when the host has neither, so
#    this never needs root and never fights a system package manager.
# ---------------------------------------------------------------------------
stage 'Ensuring Node and pnpm'
set_phase 'toolchain'

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_node() {
  local major os arch name url
  have curl || die "no Node >= ${NODE_MAJOR_MIN} and no curl to fetch one. Install Node and re-run."
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
  # busybox tar can unpack it.
  name="$(curl -fsSL "https://nodejs.org/dist/latest-v${major}.x/SHASUMS256.txt" |
    awk -v pat="-${os}-${arch}\\.tar\\.gz$" '$2 ~ pat { print $2; exit }')"
  [ -n "$name" ] || die "could not resolve a Node v${major} build for ${os}-${arch}"
  url="https://nodejs.org/dist/latest-v${major}.x/${name}"

  info "downloading ${name}"
  mkdir -p "$TOOLCHAIN_DIR/node"
  curl -fsSL "$url" | tar -xz -C "$TOOLCHAIN_DIR/node" --strip-components=1
}

if [ -x "${TOOLCHAIN_DIR}/node/bin/node" ]; then
  export PATH="${TOOLCHAIN_DIR}/node/bin:$PATH"
fi
if ! have node || [ "$(node_major)" -lt "$NODE_MAJOR_MIN" ]; then
  info "no usable Node (need >= ${NODE_MAJOR_MIN}) — installing a private one"
  install_node
  export PATH="${TOOLCHAIN_DIR}/node/bin:$PATH"
fi
info "node $(node --version)"

export PATH="${TOOLCHAIN_DIR}/bin:$PATH"
if ! have pnpm; then
  info 'pnpm not found — installing'
  if have corepack; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare --activate >/dev/null 2>&1 || true
  fi
  if ! have pnpm; then
    pm="$(node -p "(require('./package.json').packageManager||'pnpm@latest')" 2>/dev/null || echo 'pnpm@latest')"
    npm install -g --silent --prefix "$TOOLCHAIN_DIR" "$pm" >/dev/null
  fi
fi
have pnpm || die 'pnpm is required and could not be installed automatically.'
info "pnpm $(pnpm --version)"

# ---------------------------------------------------------------------------
# 5+6. Dependencies + build.
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
# 7. DB init, migrations, and first-run provisioning. Converges — a restart
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
# 8. Hand off: placeholder down, port verified free, exec the host so the
#    supervisor owns the real process. The moment between kill and the
#    host's bind reads as connection-refused upstream — treated as "still
#    starting", unlike a 30s never-bound timeout.
# ---------------------------------------------------------------------------
stage 'Starting host'
set_phase 'handoff'
# Mirrors normalizeName() — the group slug is what appears in the URL.
group_slug="$(printf '%s' "$ONCELLCLAW_GROUP" | tr '[:upper:]' '[:lower:]' |
  sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-\{1,\}//' -e 's/-\{1,\}$//')"
info "POST /web/${group_slug}/message and GET /web/${group_slug}/messages on :${PORT}"

stop_placeholder
wait_port_free
trap - EXIT
rm -f "$PHASE_FILE"
exec node dist/index.js
