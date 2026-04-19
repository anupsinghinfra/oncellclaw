---
name: new-setup
description: Shortest path from zero to a working two-way agent chat, for any user regardless of technical background — ends at a running NanoClaw instance with at least one CLI-reachable agent.
allowed-tools: Bash(bash setup.sh) Bash(bash setup/probe.sh) Bash(pnpm exec tsx setup/index.ts *) Bash(pnpm run chat *) Bash(brew install *) Bash(curl -fsSL https://get.docker.com | sh) Bash(sudo usermod -aG docker *) Bash(open -a Docker) Bash(sudo systemctl start docker)
---

# NanoClaw bare-minimum setup

Purpose of this skill is to take any user — technical or not — from zero to a two-way chat with an agent in the fewest steps possible. Done means a running NanoClaw instance with at least one agent reachable via the CLI channel.

Only run the steps strictly required for the NanoClaw process to start and respond to the user end-to-end. Everything else is deferred to post-setup skills.

For each step, print a one-liner to the user explaining what it does and why it's needed. Keep the tone friendly and lightly informative — context, not jargon.

Each step is invoked as `pnpm exec tsx setup/index.ts --step <name>` and emits a structured status block Claude parses to decide what to do next.

Start with a probe: a single parallel scan that snapshots every prerequisite and dependency. The rest of the flow reads this snapshot to decide what to run, skip, or ask about — no per-step re-checking. The probe is plain ESM JS (`setup/probe.mjs`) with no external deps so it can run before step 1 has installed `pnpm`/`node_modules`.

## Current state

!`bash setup/probe.sh`

## Flow

Parse the probe block above. For each step below, consult the named probe fields and skip, ask, or run accordingly. Before running any step, say the quoted one-liner to the user.

If the probe reports `STATUS: unavailable` (Node isn't installed yet), ignore all `skip if …` probe conditions and run every step from 1 onward — each step has its own idempotency check, so re-running is safe.

### 1. Node bootstrap

Always runs — probe can't report on this since it lives below the Node layer.

> *"Now I'm installing Node and your project's dependencies, so the rest of setup has what it needs to run."*

Run `bash setup.sh`. Parse the status block.

- `NODE_OK=false` → Offer to install Node 22 (macOS: `brew install node@22`; Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`). Re-run.
- `DEPS_OK=false` or `NATIVE_OK=false` → Read `logs/setup.log`, fix, re-run.

> **Loose command:** `bash setup.sh`. Justification: pre-Node bootstrap. Can't call the Node-based dispatcher before Node and `pnpm install` are in place.

### 2. Docker

Check probe results and skip if `DOCKER=running` AND `IMAGE_PRESENT=true`.

**Runtime:**
- `DOCKER=not_found` →
  > *"Now I'm installing Docker so your agents can work safely in a contained environment."*
  - macOS: `brew install --cask docker && open -a Docker`
  - Linux: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER` (tell user they may need to log out/in for group membership)
- `DOCKER=installed_not_running` →
  > *"Starting Docker up so the agent containers can come online."*
  - macOS: `open -a Docker`
  - Linux: `sudo systemctl start docker`

Wait ~15s after either, then proceed.

> **Loose commands:** Docker install/start. Justification: platform-specific package-manager invocations. Wrapping them in a `--step` would just move the same branching into TypeScript with no added value.

**Image (run if `IMAGE_PRESENT=false`):**

> *"Next I'm building the agent container image — takes a few minutes the first time, but it's a one-off."*

`pnpm exec tsx setup/index.ts --step container -- --runtime docker`

### 3. OneCLI

Check probe results and skip if `ONECLI_STATUS=healthy`.

> *"Now I'm installing OneCLI — a local vault that keeps your API keys safe and hands them to your agents only when they need them."*

`pnpm exec tsx setup/index.ts --step onecli`

### 4. Anthropic credential

Check probe results and skip if `ANTHROPIC_SECRET=true`.

> *"Your agent needs an Anthropic credential to talk to Claude. Let's get that set up."*

Use `AskUserQuestion`:
1. **Claude subscription (Pro/Max)** — "Run `claude setup-token` in another terminal. It prints a token; paste it back here when ready."
2. **Anthropic API key** — "Get one from https://console.anthropic.com/settings/keys."

Wait for the token. When received, run:

`pnpm exec tsx setup/index.ts --step auth -- --create --value <TOKEN>`

### 5. Service

Check probe results and skip if `SERVICE_STATUS=running`.

> *"Starting the NanoClaw background service so it can relay messages between you and your agent."*

`pnpm exec tsx setup/index.ts --step service`

### 6. First CLI agent

Check probe results and skip if `CLI_AGENT_WIRED=true`.

> *"Now I'm creating your first agent and hooking it up to the terminal so you can start chatting."*

Ask: *"What should I call you?"* Default: the value of `INFERRED_DISPLAY_NAME` from probe.

`pnpm exec tsx setup/index.ts --step cli-agent -- --display-name "<name>"`

### 7. First chat

> *"You're all set — send your first message to your agent:"*

`pnpm run chat hi`

The agent should reply within ~60s (first container spin-up is slowest). If no reply, tail `logs/nanoclaw.log`.

> **Loose command:** `pnpm run chat hi`. Justification: this is the command the user will keep using after setup. Hiding it behind a `--step` would force them to memorize a second way to do the same thing.

## If anything fails

Any step that reports `STATUS: failed` in its status block: read `logs/setup.log`, diagnose, fix the underlying cause, re-run the same `--step`. Don't bypass errors to keep moving.
