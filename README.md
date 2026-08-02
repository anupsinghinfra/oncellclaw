<p align="center">
  <img src="assets/oncellclaw-logo.svg" alt="oncellclaw" width="400">
</p>

<p align="center">
  <strong>oncellclaw — the assistant that survives your laptop.</strong>
</p>

<p align="center">
  A <a href="https://github.com/nanocoai/nanoclaw">NanoClaw</a> fork that runs each agent in its own durable <a href="https://oncell.ai">OnCell</a> cell instead of a local Docker container. Same tiny, understandable codebase; your agents' memory and files now live in the cloud, cost ~$0 while idle, and wake on the next message — even if your machine is off. Docker remains a fully supported local runtime.
</p>

<p align="center">
  <a href="https://oncellclaw.com">oncellclaw.com</a>&nbsp; • &nbsp;
  <a href="https://oncell.ai/claw">hosted&nbsp;(oncell.ai/claw)</a>&nbsp; • &nbsp;
  <a href="https://oncell.ai/docs">OnCell&nbsp;docs</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/ZmzTebH9xv"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="README_ko.md">한국어</a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## Why oncellclaw

A personal assistant has access to your life, so two things matter more than features: you should be able to *read* the code that runs it, and it should be *isolated* — really isolated, not behind permission checks.

[NanoClaw](https://github.com/nanocoai/nanoclaw) got both right. Where [OpenClaw](https://github.com/openclaw/openclaw) is nearly half a million lines, 53 config files and 70+ dependencies running in one Node process with shared memory, NanoClaw is one process and a handful of files you can actually audit, with agents in their own Linux containers. oncellclaw keeps that codebase — and its thesis — intact.

What it changes is *where the isolation lives*. Containers on your laptop mean your assistant dies with your laptop: close the lid and it stops; reinstall and its memory is gone; travel and it is not with you. So each agent group moves into a gVisor-sandboxed [OnCell](https://oncell.ai) cell — the same OS-level boundary, no longer tied to your machine, and now *durable*:

- **Its whole world lives in the cell** — `CLAUDE.md`, memory, and working files survive laptop death, reinstalls, and travel.
- **Idle costs ~$0** — a group that isn't talking pauses to storage; your next message wakes it.
- **Snapshot or fork it** — the cell's filesystem is snapshot-able and forkable through the OnCell API, so you can checkpoint an assistant or clone its entire state.
- **Credentials never touch the workspace** — they are passed as service environment only, never written to a file the agent can read.

The host process shrinks to a channel router: messages in, messages out. Everything the agent actually does happens in its cell. No `ONCELL_API_KEY`? Everything still runs fully local on Docker, exactly like upstream NanoClaw.

## Two ways to run it

- **Hosted — [oncell.ai/claw](https://oncell.ai/claw)**: sign in, pair a channel, message your assistant. No install; your agents live in OnCell cells from the first message. *(Rolling out.)*
- **Self-hosted** — clone this repo and run the setup below. Your machine is the channel router; agents run on OnCell (or fully local on Docker, exactly like upstream NanoClaw).

## What it can do

Every bullet here is shipping code — follow the links and read it. Agent-side capabilities live in [`container/skills/`](container/skills/) and [`container/agent-runner/src/mcp-tools/`](container/agent-runner/src/mcp-tools/); install-time capabilities are the [`.claude/skills/`](.claude/skills/) slash commands.

**Talk to it anywhere**

- **Web chat, built in** — `POST` a message, poll the full two-way transcript, or hold open a Server-Sent-Events stream; bearer-token auth and rate limiting included. A browser or a dashboard is a complete client. ([`src/channels/web.ts`](src/channels/web.ts))
- **Telegram in one paste** — create a bot with @BotFather, `POST /web/channels/telegram/pair`, done. Long-polling, so it works behind NAT and on hosted cells with no webhook. ([`src/channels/telegram.ts`](src/channels/telegram.ts))
- **A dozen more channels as skills** — WhatsApp, Discord, Slack, iMessage, Teams, Matrix, Google Chat, Webex, Signal, WeChat, Linear, GitHub, email via Resend: `/add-<channel>` copies exactly the adapter you asked for into your fork. ([`.claude/skills/`](.claude/skills/))
- **One assistant or many** — wire each channel to its own agent for privacy, share one agent across channels for unified memory, or fold channels into a single conversation. Per-channel choice via `/manage-channels`. ([docs/isolation-model.md](docs/isolation-model.md))

**What your assistant does**

- **Browses the web** — research, form-filling, screenshots, data extraction, testing web apps through a real browser. ([`container/skills/agent-browser`](container/skills/agent-browser/SKILL.md))
- **Schedules its own work** — one-shot and cron-recurring tasks, each in an isolated session with a run log; optional [script gates](docs/scheduled-tasks.md) check for new work cheaply so the agent only wakes when there is some. ([`src/modules/scheduling/`](src/modules/scheduling/))
- **Spins up teammates** — `create_agent` births a new long-lived agent with its own workspace, wired bidirectionally: delegate to it, get messages back. Agent-to-agent messaging works between any wired pair. ([`mcp-tools/agents.ts`](container/agent-runner/src/mcp-tools/agents.ts), [`src/modules/agent-to-agent/`](src/modules/agent-to-agent/))
- **Asks before acting** — privileged actions (installing packages, adding MCP servers, creating agents) go through approval cards to an admin; the guard sits in the delivery path, not in the agent's good intentions. ([`src/modules/approvals/`](src/modules/approvals/), [`src/delivery-guard.ts`](src/delivery-guard.ts))
- **Asks you things properly** — blocking multiple-choice questions and rich cards on channels that support them. ([`mcp-tools/interactive.ts`](container/agent-runner/src/mcp-tools/interactive.ts))
- **Sends real artifacts** — files, charts, PDFs into chat; edits its own sent messages; reacts to yours. ([`mcp-tools/core.ts`](container/agent-runner/src/mcp-tools/core.ts))
- **Extends itself** — installs apt/npm packages, adds MCP servers, edits its own instructions and code (approval-gated), with a builder-agent pattern for bigger changes. ([`container/skills/self-customize`](container/skills/self-customize/SKILL.md), [`mcp-tools/self-mod.ts`](container/agent-runner/src/mcp-tools/self-mod.ts))
- **Builds web software like it means it** — a frontend-engineering discipline skill enforces build-test-verify in a real browser before "done", pairing with a deploy skill like `/add-vercel`. ([`container/skills/frontend-engineer`](container/skills/frontend-engineer/SKILL.md))
- **Remembers** — per-agent `CLAUDE.md` standing instructions plus a structured, budgeted memory index that survives every restart, composed fresh into each session. ([`src/claude-md-compose.ts`](src/claude-md-compose.ts), [`container/agent-runner/src/memory/`](container/agent-runner/src/memory/))
- **Administers its own install** — the in-container `ncl` CLI queries and (permission-gated) modifies channels, wirings, tasks, and sessions. ([`src/cli/`](src/cli/))

**Under the hood**

- **Survives your laptop** — on the OnCell runtime each agent's whole world (memory, files, `CLAUDE.md`) lives in a durable gVisor cell: laptop dies, assistant doesn't. Idle cells pause to storage at ~$0; your next message wakes them. ([`src/cell-runner.ts`](src/cell-runner.ts))
- **Snapshot and fork** — a cell's filesystem can be checkpointed or cloned through the OnCell API: back up an assistant, or fork its entire state.
- **Fully local option** — no `ONCELL_API_KEY`, and everything runs in local Docker containers exactly like upstream NanoClaw. ([`src/container-runner.ts`](src/container-runner.ts))
- **Credential vault** — with a [OneCLI gateway](https://github.com/onecli/onecli), agents never hold raw API keys: credentials are injected at request time with per-agent policies, and docker installs can hard-lock all egress through it. ([`src/egress-lockdown.ts`](src/egress-lockdown.ts), [`src/cell-gateway.ts`](src/cell-gateway.ts))
- **Sandboxed by construction** — every agent runs in its own container or cell and sees only the mounts you allowlist. ([`src/modules/mount-security/`](src/modules/mount-security/))
- **Users, roles, unknown senders** — owner/admin/member roles per user; a stranger messaging your bot triggers an approval card, not a conversation. ([`src/modules/permissions/`](src/modules/permissions/))
- **Agent templates** — stamp a ready-to-run agent (instructions + tools + skills, no secrets) with `ncl groups create --template <ref>`. ([docs/templates.md](docs/templates.md))
- **Model choice per agent** — Claude Code natively; `/add-codex`, `/add-opencode` (OpenRouter, Google, DeepSeek…), `/add-ollama-provider` for local open-weight models. ([`.claude/skills/`](.claude/skills/))

## Hosted (how it works)

There is no separate hosted codebase. A hosted instance is *this* repo running as the service inside your own OnCell cell, started by [`scripts/cloud-start.sh`](scripts/cloud-start.sh) — the same script [oncell.ai/dashboard/claw](https://oncell.ai/claw) runs for you, and the same one you can run yourself on any box that has internet. The bootstrap is **node-only**: cells ship node, npm/corepack and tar but **no git, curl, wget or python3** — so the source arrives as a GitHub tarball fetched by node (`ONCELLCLAW_REF` is resolved to a commit sha via the GitHub API, then the `codeload.github.com/{owner}/{repo}/tar.gz/{sha}` tarball is downloaded and extracted), pnpm comes from corepack shims, and every download in the script goes through `node fetch`. One command takes an empty machine to a live assistant: fetch + extract the source, provision the toolchain, install, build, provision one agent group paired to the built-in [`web` channel](src/channels/web.ts), then `exec` the host so your supervisor owns the process.

The base directory (`ONCELLCLAW_DIR`, default `~/oncellclaw`) separates immutable source from durable state, so an update can never destroy your assistant's memory:

```
current -> src-<sha>   the running checkout (symlink, flipped atomically)
src-<sha>/             immutable source tree for one commit
state/                 data/ groups/ store/ .env — symlinked into every
                       checkout; survives every update
toolchain/             corepack shims (+ a private node if the system one is old)
```

Every stage is idempotent, so a restart converges instead of duplicating: a sha that is already extracted means no download at all (a warm restart pinned to a full sha boots fully offline), a new sha is extracted alongside and `current` is flipped, and old trees are pruned only after the new one has built and provisioned — a failed update never deletes the last known-good checkout. Provisioning finds the agent group it already made rather than making a second one. With `ONCELLCLAW_RUNTIME=oncell` the host's own agent groups live in sibling cells under the same account, so the host cell stays a thin router. The `web` channel puts the whole conversation on the process's single HTTP port (`$PORT`), which is what the cell's public preview URL maps to:

```bash
# talk to it
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"hello"}' https://<host>/web/assistant/message          # → 202 {"ok":true,"id":"web-…"}
# poll for replies (echo `cursor` back as `after` next time)
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/messages?after='                      # → 200 {"messages":[…],"cursor":"…"}
# the full two-way conversation (user + assistant rows, ordered, resumable)
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/transcript?after='                    # → 200 {"messages":[{direction,…}],"cursor":"…"}
# push instead of polling: Server-Sent Events, one `event: message` per row
curl -N -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/stream'                               # replays, then streams live
curl https://<host>/web/health                                           # → 200 {"ok":true,"groups":[…]}
# introspection for dashboards (token-authed): version, groups, channels, skills
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     https://<host>/web/status                                           # → 200 {"version":…,"channels":[…],…}
```

**First boot:** the script binds `$PORT` immediately — before downloading anything — with a tiny placeholder server, because service supervisors (the OnCell cell supervisor included) kill a service that isn't accepting connections within seconds, and a cold install takes minutes. While bootstrap runs, **every** path (including `/web/health`) answers `503` with `{"ok":false,"phase":"…"}`, where `phase` walks `starting → clone → toolchain → install → build → provision → handoff`. A brief connection-refused gap follows while the placeholder hands the port to the real host, then `/web/health` returns `200 {"ok":true,…}` — poll it until `ok` is true to know the assistant is live. Warm restarts skip the download and install work and hand off in seconds.

Since cells have no curl, the service command that fetches and runs the script is itself node-only:

```sh
node -e 'const fs=require("fs");const repo=process.env.ONCELLCLAW_REPO||"https://github.com/anupsinghinfra/oncellclaw.git";const ref=process.env.ONCELLCLAW_REF||"main";const m=repo.match(/github\.com[:\/]([^\/]+)\/([^\/]+?)(?:\.git)?$/);if(!m){console.error("cannot parse ONCELLCLAW_REPO: "+repo);process.exit(1)}const url="https://raw.githubusercontent.com/"+m[1]+"/"+m[2]+"/"+ref+"/scripts/cloud-start.sh";fetch(url,{headers:{"User-Agent":"oncellclaw-bootstrap"}}).then(async r=>{if(!r.ok){console.error("HTTP "+r.status+" for "+url);process.exit(1)}const t=await r.text();if(!t.includes("cloud-start.sh")){console.error("unexpected script body from "+url);process.exit(1)}fs.writeFileSync("/tmp/cloud-start.sh",t);console.log("fetched "+url)}).catch(e=>{console.error("fetch failed: "+e);process.exit(1)})' && bash /tmp/cloud-start.sh
```

That URL is public, so `ONCELLCLAW_WEB_TOKEN` is the only thing between the internet and your assistant: the channel refuses to start without one unless you explicitly set `ONCELLCLAW_WEB_ALLOW_INSECURE=1` for a trusted local network. Nothing here writes a secret to disk — credentials travel in the process environment only. The channel also rate-limits itself: failed auth attempts are capped per client IP (default 20/min, checked *before* the token compare so brute-forcing a leaked URL hits a wall) and message `POST`s are capped per group (default 30/min, burst-friendly token bucket). Over-budget requests get `429 {"error":"rate_limited"}` with a `Retry-After` header; `GET` polls and `/health` are never limited.

| Variable | Default | Meaning |
|---|---|---|
| `ONCELLCLAW_WEB_TOKEN` | — | Bearer token for every `/web/…` request. **Required** unless the insecure flag is set. Generate with `openssl rand -hex 32`. |
| `ONCELLCLAW_WEB_ALLOW_INSECURE` | unset | `1` runs the `web` channel with no authentication. Local development only. |
| `ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN` | `20` | Failed auth attempts one client IP may make per minute before `/web/…` answers `429` (sliding window, consulted before the token compare). |
| `ONCELLCLAW_WEB_MESSAGES_PER_MIN` | `30` | Message `POST`s one group accepts per minute (token bucket; bursts up to the same number). `GET` polls and `/health` are never limited. |
| `PORT` | `3000` | HTTP listen port. Always set by the cell supervisor on hosted runs — the fallback is for bare self-hosting only. `WEBHOOK_PORT` still overrides it. |
| `ONCELLCLAW_GROUP` | `assistant` | Agent group to provision. Also the URL slug: `/web/<group>/message`. |
| `ONCELLCLAW_PERSONA` | — | Standing instructions for that group, staged once as its persona. Never overwrites an edited one. |
| `ONCELLCLAW_REPO` | this repo | GitHub repo URL to run (tarball bootstrap — must be `github.com`). |
| `ONCELLCLAW_REF` | `main` | Branch, tag, or commit sha. A full 40-hex sha skips ref resolution and warm-restarts offline. |
| `ONCELLCLAW_DIR` | `$HOME/oncellclaw` | Persistent base: `src-<sha>/` checkouts, the `current` symlink, `state/` (`data`, `groups`, `store`, `.env`) and `toolchain/`. State survives every update. |
| `ONCELLCLAW_RUNTIME` | `oncell` | `oncell` or `docker` (see [Runtimes](#runtimes-oncell-cells-or-local-docker)). |
| `ONCELLCLAW_CELL_NAMESPACE` | install slug | Isolates this instance's agent-group cells (`clawg-{namespace}-{group}`) from other claws in the same OnCell account. Kebab-case, ≤24 chars. Hosted: the dashboard sets a unique value per instance; self-host: the default (sha1 of the checkout path) is fine. |
| `ONCELL_API_KEY` | — | Required when the runtime is `oncell`. |
| `ONCELL_API_URL` | — | Optional API endpoint override. |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | — | Agent credential. Exactly one is required. |

The `web` channel is not hosted-only — it ships in main like `cli` does, so a self-hoster can point a browser, a script, or their own frontend at a local oncellclaw with the same three endpoints. See [config-examples/hosted.env.example](config-examples/hosted.env.example).

### Connect Telegram

Main ships a dependency-free Telegram adapter that runs in **long-polling** mode — no public webhook, so it works identically on a hosted cell and on a laptop behind NAT. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`, copy the token it prints), then either:

- **Dashboard**: Connections & Integrations → Telegram → Connect → paste the token. The panel is a thin client for the API below.
- **API/curl**:

```bash
curl -X POST -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" -H 'Content-Type: application/json' \
     -d '{"botToken":"<token from BotFather>"}' https://<host>/web/channels/telegram/pair
# → 200 {"ok":true,"bot":{"username":"YourBot"}}      paired; adapter is live immediately
# → 400 {"error":"invalid_token"}                     bad shape, or Telegram rejected it
# → 502 {"error":"telegram_unreachable"}              Telegram API not reachable from the host
curl -X DELETE -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" https://<host>/web/channels/telegram
# → 200 {"ok":true}                                   adapter stopped, credential removed
```

Pairing verifies the token against `getMe`, stores it as `TELEGRAM_BOT_TOKEN` in the install's `.env` (the same place the CLI setup path writes it — one credential store however you pair), and starts the adapter without a restart. `/web/status` reflects it immediately (`configured:true, connected:true, detail:"@YourBot"`), and always lists the full supported channel set (`web`, `cli`, `telegram`, `whatsapp`, `discord`, `imessage`) with honest states so a dashboard has a row to hang every Connect button on. Message your bot on Telegram and the assistant answers there; DMs from senders you haven't approved go through the normal unknown-sender approval flow.

## Quick Start (self-hosted)

```bash
git clone https://github.com/anupsinghinfra/oncellclaw.git
cd oncellclaw
bash oncellclaw.sh
```

`oncellclaw.sh` walks you from a fresh machine to a named agent you can message. It installs Node, pnpm, and Docker if missing, registers your Anthropic credential with OneCLI, builds the agent container, and pairs your first channel (iMessage, Telegram, Discord, WhatsApp, or a local CLI). If a step fails, Claude Code is invoked automatically to diagnose and resume from where it broke.

To run agents on OnCell instead of local Docker, add `ONCELL_API_KEY=oncell_sk_...` to `.env` before (or after) setup — see [config-examples/oncell.env.example](config-examples/oncell.env.example). The Docker install step can then be skipped entirely.

<details>
<summary><strong>Migrating from NanoClaw v1?</strong></summary>

Run from a fresh v2 checkout next to your v1 install:

```bash
git clone https://github.com/anupsinghinfra/oncellclaw.git nanoclaw-v2
cd nanoclaw-v2
bash migrate-v2.sh
```

`migrate-v2.sh` finds your v1 install (sibling directory, or `NANOCLAW_V1_PATH=/path/to/nanoclaw`), migrates state into the v2 checkout, then `exec`s into Claude Code to finish the parts that need judgment (owner seeding, shared-memory migration, fork-customisation replay).

Run the script directly, not from inside a Claude session — the deterministic side needs interactive prompts and real shell I/O for Node/pnpm bootstrap, Docker, OneCLI, and the container build.

**What it does:** merges `.env`, seeds the v2 DB from `registered_groups`, copies group folders + session data + scheduled tasks, installs the channel adapters you select, copies channel auth state (including the Baileys keystore for WhatsApp — LID mapping is now resolved per-message by the Baileys v7 adapter, not migrated), builds the agent container.

**What it doesn't:** flip the system service. Pick *"switch to v2"* at the prompt, or do it manually after testing — your v1 install is left untouched.

See [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) for what's different and [docs/migration-dev.md](docs/migration-dev.md) for development notes.

</details>

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native, hybrid by design.** The install and onboarding flow is an optimized scripted path, fast and deterministic. When a step needs judgment, whether a failed install, a guided decision, or a customization, control hands off to Claude Code seamlessly. Beyond setup there's no monitoring dashboard or debugging UI either: describe the problem in chat and Claude Code handles it.

**Skills over features.** Trunk ships the registry and infrastructure, not specific channel adapters or alternative agent providers. Channels (Discord, Slack, Telegram, WhatsApp, …) live on a long-lived `channels` branch; alternative providers (OpenCode, Ollama) live on `providers`. You run `/add-telegram`, `/add-opencode`, etc. and the skill copies exactly the module(s) you need into your fork. No feature you didn't ask for.

**Best harness, best model.** NanoClaw natively uses Claude Code via Anthropic's official Claude Agent SDK, so you get the latest Claude models and Claude Code's full toolset, including the ability to modify and expand your own NanoClaw fork. Other providers are drop-in options: `/add-codex` for OpenAI's Codex (ChatGPT subscription or API key), `/add-opencode` for OpenRouter, Google, DeepSeek and more via OpenCode, and `/add-ollama-provider` for local open-weight models. Provider is configurable per agent group.

## Accounts and what leaves your machine

NanoClaw has no user accounts. The only thing it reports is anonymous setup diagnostics, and
`NANOCLAW_NO_DIAGNOSTICS=1` turns those off. Your agents, messages, files and keys never leave
your machine.

One opt-in exception: you can [fetch a prebuilt agent image](docs/hardened-image.md) instead of
building it locally. Fetching ours needs a free account, so we see your email address and when
you ask for an image — nothing about your agents, and nothing after the image lands. Building
locally needs no account and contacts nothing, and is the default.

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From a channel you own or administer, you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add a new channel or agent provider, don't add it to trunk. New channel adapters land on the `channels` branch; new agent providers land on `providers`. Users install them in their own fork with `/add-<name>` skills, which copy the relevant module(s) into the standard paths, wire the registration, and pin dependencies.

This keeps trunk as pure registry and infra, and every fork stays lean — users get the channels and providers they asked for and nothing else.

### RFS (Request for Skills)

No channel or provider skills are currently requested — propose one via an issue.

## Requirements

- macOS or Linux (Windows via WSL2)
- Node.js 20+ and pnpm 10+ (the installer will install both if missing)
- An [OnCell](https://oncell.ai) API key (`ONCELL_API_KEY`) for the cell runtime, **or** [Docker Desktop](https://docker.com/products/docker-desktop) (macOS/Windows) / Docker Engine (Linux) for the local runtime
- [Claude Code](https://claude.ai/download) for `/customize`, `/debug`, error recovery during setup, and all `/add-<channel>` skills

## Architecture

```
messaging apps → host process (router) → inbound.db → container (Bun, Claude Agent SDK) → outbound.db → host process (delivery) → messaging apps
```

A single Node host orchestrates per-session agent containers. When a message arrives, the host routes it via the entity model (user → messaging group → agent group → session), writes it to the session's `inbound.db`, and wakes the container. The agent-runner inside the container polls `inbound.db`, runs the agent, and writes responses to `outbound.db`. The host polls `outbound.db` and delivers back through the channel adapter.

Two SQLite files per session, each with exactly one writer — no cross-mount contention, no IPC, no stdin piping. Channels and alternative providers self-register at startup; trunk ships the registry and the Chat SDK bridge, while the adapters themselves are skill-installed per fork.

### Runtimes: OnCell cells or local Docker

The runtime is selected at startup (`src/runtime-select.ts`):

| `ONCELLCLAW_RUNTIME` | `ONCELL_API_KEY` | Runtime |
|---|---|---|
| `docker` | any | Docker (explicit opt-out) |
| `oncell` | any | OnCell (fails fast if the key is missing) |
| unset | set | OnCell (the fork's default) |
| unset | unset | Docker (upstream behavior, fully local) |

On the OnCell runtime the file protocol above is unchanged — the bind mount is replaced by a sync pump. One cell per agent group, named `clawg-{namespace}-{group}`: the `namespace` (`ONCELLCLAW_CELL_NAMESPACE`, default = the install slug) isolates this instance's cells from any other oncellclaw sharing the OnCell account — hosted instances themselves live in `claw-*` cells, a separate namespace this code never creates or stops. The group folder, composed `CLAUDE.md`, skills, and the agent-runner source are mirrored into the cell incrementally (content-hash manifest in the cell KV), the runner runs as the cell's supervised service, and a per-session pump pushes `inbound.db`/inbox and pulls `outbound.db`/heartbeat/outbox through the cell request door. Credentials are passed only in the service environment at start — never written into cell files. Host-side delivery and sweep read the same local session files they always did.

> **Migrating from pre-namespace installs:** group cells used to be named `claw-{group}`. Those are no longer matched — on its next wake each group starts a fresh `clawg-{namespace}-{group}` cell without the old cell's files or memory, and the host logs a `Legacy cell naming detected` warning at boot listing the old and new customer ids. To keep the old state, migrate manually via the OnCell API (fork or rename the legacy cell to the new customer id), then delete the legacy cell. The host never auto-adopts `claw-*` cells: that prefix is also used for hosting cells, so ownership of any given one is ambiguous.

Config (`.env`):

```bash
ONCELL_API_KEY=oncell_sk_...        # enables the OnCell runtime
ONCELL_API_URL=https://api.oncell.ai # optional override
ONCELLCLAW_RUNTIME=oncell|docker     # optional explicit selection
```

For the full architecture writeup see [docs/architecture.md](docs/architecture.md); for the three-level isolation model see [docs/isolation-model.md](docs/isolation-model.md).

Key files:
- `src/index.ts` — entry point: DB init, channel adapters, delivery polls, sweep
- `src/router.ts` — inbound routing: messaging group → agent group → session → `inbound.db`
- `src/delivery.ts` — polls `outbound.db`, delivers via adapter, handles system actions
- `src/host-sweep.ts` — 60s sweep: stale detection, due-message wake, recurrence
- `src/session-manager.ts` — resolves sessions, opens `inbound.db` / `outbound.db`
- `src/container-runner.ts` — spawns per-agent-group containers, OneCLI credential injection
- `src/cell-runner.ts` — OnCell runtime: cell lifecycle, workspace sync, session IPC pump
- `src/cell-sync.ts` / `src/cell-session-io.ts` — incremental cell sync + door-based session IPC
- `src/oncell-client.ts` — minimal self-contained OnCell API client
- `src/db/` — central DB (users, roles, agent groups, messaging groups, wiring, migrations)
- `src/channels/` — channel adapter infra (adapters installed via `/add-<channel>` skills)
- `src/channels/web.ts` — built-in `web` channel: HTTP chat + health on the one port (`/web/health`, and bare `/health` for self-hosts — hosted preview proxies reserve top-level `/health` for themselves)
- `src/webhook-server.ts` — that one HTTP port (`WEBHOOK_PORT`, else `PORT`, else 3000)
- `src/web-provision.ts` / `scripts/provision.ts` — non-interactive setup: one group paired to `web`
- `scripts/cloud-start.sh` — empty machine → running host; the hosted bootstrap
- `src/providers/` — host-side provider config (`claude` baked in; others via skills)
- `container/agent-runner/` — Bun agent-runner: poll loop, MCP tools, provider abstraction
- `groups/<folder>/` — per-agent-group filesystem (`CLAUDE.md`, skills, container config)

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and Windows via WSL2) and a mature ecosystem.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `bash oncellclaw.sh`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials never enter the container — outbound API requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects authentication at the proxy level and supports rate limits and access policies. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. The supported path is `/add-opencode` (OpenRouter, OpenAI, Google, DeepSeek, and more via OpenCode config) or `/add-ollama-provider` (local open-weight models via Ollama). Both are configurable per agent group, so different agents can run on different backends in the same install.

For one-off experiments, any Claude API-compatible endpoint also works via `.env`:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If a step fails, `oncellclaw.sh` hands off to Claude Code to diagnose and resume. If that doesn't resolve it, run `claude`, then `/debug`. If Claude identifies an issue likely to affect other users, open a PR against the relevant setup step or skill.

**How do I uninstall NanoClaw?**

```bash
bash oncellclaw.sh --uninstall
```

Every install is tagged with a per-checkout id, so the uninstaller removes only what belongs to that copy: the background service, containers and image, app data and logs, your agents' files, and this copy's OneCLI vault agents. Shared things — the OneCLI app and your credentials, other NanoClaw copies on the machine — are left alone. It shows exactly what it found and asks for confirmation per group; nothing is deleted until you say yes. Use `--dry-run` to preview without changing anything, or `--yes` to skip the prompts. Your `.env` is backed up before removal. To finish, delete the checkout folder itself.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills: channel and provider code on the `channels`/`providers` registry branches, everything else as a self-contained skill. See [docs/customizing.md](docs/customizing.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
