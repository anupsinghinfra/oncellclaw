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

## What It Supports

- **Multi-channel messaging** — WhatsApp, Telegram, Discord, Slack, Microsoft Teams, iMessage, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, and email via Resend. Installed on demand with `/add-<channel>` skills. Run one or many at the same time.
- **Flexible isolation** — connect each channel to its own agent for full privacy, share one agent across many channels for unified memory with separate conversations, or fold multiple channels into a single shared session so one conversation spans many surfaces. Pick per channel via `/manage-channels`. See [docs/isolation-model.md](docs/isolation-model.md).
- **Per-agent workspace** — each agent group has its own `CLAUDE.md`, its own memory, its own container, and only the mounts you allow. Nothing crosses the boundary unless you wire it to.
- **Scheduled tasks**: recurring jobs executed by the agent, with optional [script gates](docs/scheduled-tasks.md) that avoid waking it when there is no work
- **Web access** — search and fetch content from the web
- **Container isolation** — agents are sandboxed in Docker containers (macOS/Linux/WSL2)
- **Credential security** — agents never hold raw API keys. Outbound requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects credentials at request time and enforces per-agent policies and rate limits.
- **Agent templates**: stamp a ready-to-run agent (instructions + MCP tools + skills, no secrets) from a reusable bundle via `ncl groups create --template <ref>`. Templates load from the local `templates/` folder; populate it by hand or by copying from the [public library](https://github.com/nanocoai/nanoclaw-templates). See [docs/templates.md](docs/templates.md).

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

On the OnCell runtime the file protocol above is unchanged — the bind mount is replaced by a sync pump. One cell per agent group (`claw-<group-folder>`): the group folder, composed `CLAUDE.md`, skills, and the agent-runner source are mirrored into the cell incrementally (content-hash manifest in the cell KV), the runner runs as the cell's supervised service, and a per-session pump pushes `inbound.db`/inbox and pulls `outbound.db`/heartbeat/outbox through the cell request door. Credentials are passed only in the service environment at start — never written into cell files. Host-side delivery and sweep read the same local session files they always did.

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
