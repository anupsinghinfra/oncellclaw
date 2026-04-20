---
name: new-setup
description: Shortest path from zero to a working two-way agent chat, for any user regardless of technical background — ends at a running NanoClaw instance with at least one CLI-reachable agent.
allowed-tools: Bash(bash setup.sh) Bash(bash setup/probe.sh) Bash(pnpm exec tsx setup/index.ts:*) Bash(pnpm run chat:*) Bash(curl -fsSL https://get.docker.com | sh) Bash(curl -fsSL https://deb.nodesource.com/setup_22.x) Bash(sudo apt-get install -y nodejs) Bash(sudo usermod -aG docker:*) Bash(open -a Docker) Bash(sudo systemctl start docker) Bash(node --version) Bash(tail:*) Bash(head:*) Bash(grep:*)
---

# NanoClaw bare-minimum setup

Purpose of this skill is to take any user — technical or not — from zero to a two-way chat with an agent in the fewest steps possible. Done means a running NanoClaw instance with at least one agent reachable via the CLI channel.

Only run the steps strictly required for the NanoClaw process to start and respond to the user end-to-end. Everything else is deferred to post-setup skills.

Before each step, narrate to the user in your own words what's about to happen — one short, friendly sentence, no jargon. Don't read a scripted line; use the step context below to speak naturally.

Each step is invoked as `pnpm exec tsx setup/index.ts --step <name>` and emits a structured status block Claude parses to decide what to do next.

Start with a probe: a single upfront scan that snapshots every prerequisite and dependency. The rest of the flow reads this snapshot to decide what to run, skip, or ask about — no per-step re-checking. The probe is pure bash (`setup/probe.sh`) with no external deps so it runs correctly before Node has been installed.

## Current state

!`bash setup/probe.sh`

## Flow

Parse the probe block above. For each step below, consult the named probe fields and skip, ask, or run accordingly. The probe always returns a real snapshot — there is no "node not installed" fallback; `HOST_DEPS=missing` is how you know Node/pnpm haven't been bootstrapped yet.

## Ordering and parallelism

Run steps sequentially by default: invoke the step, wait for its status block, act on the result, move to the next.

One permitted parallelism:

- **Step 2 (container image build) and step 3 (OneCLI install)** are independent — they may start together in the background.
- **Step 4 (auth) must NOT start until step 3 has completed.** Auth writes the secret into the OneCLI vault; if OneCLI isn't installed and healthy yet, the user gets asked for a credential the system can't store. Do not open an `AskUserQuestion` for step 4 while OneCLI is still installing.
- Step 2's image build may continue running past step 4 — the image isn't consumed until step 6 (first CLI agent). Join before step 6.

### 1. Node bootstrap

Check probe results and skip if `HOST_DEPS=ok` — Node, pnpm, `node_modules`, and `better-sqlite3`'s native binding are already in place.

If `HOST_DEPS=missing` and `node --version` fails (Node isn't installed at all), install Node 22 **before** running `bash setup.sh`, otherwise the first bootstrap run is guaranteed to fail:

- macOS: `brew install node@22`
- Linux / WSL: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`

Then run `bash setup.sh`. If Node is already present and only `HOST_DEPS=missing`, run `bash setup.sh` directly — deps just haven't been installed yet.

Parse the status block:

- `NODE_OK=false` → Node install didn't take effect (PATH issue, keg-only formula, etc.). Investigate `logs/setup.log`, resolve, re-run.
- `DEPS_OK=false` or `NATIVE_OK=false` → Read `logs/setup.log`, fix, re-run.

> **Loose command:** `bash setup.sh`. Justification: pre-Node bootstrap. Can't call the Node-based dispatcher before Node and `pnpm install` are in place.

### 2. Docker

Check probe results and skip if `DOCKER=running` AND `IMAGE_PRESENT=true`.

**Runtime:**
- `DOCKER=not_found` → Docker itself is missing — install it so agent containers have an isolated place to run.
  - macOS: `brew install --cask docker && open -a Docker`
  - Linux: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER` (tell user they may need to log out/in for group membership)
- `DOCKER=installed_not_running` → Docker is installed but the daemon is down — start it.
  - macOS: `open -a Docker`
  - Linux: `sudo systemctl start docker`

Wait ~15s after either, then proceed.

> **Loose commands:** Docker install/start. Justification: platform-specific package-manager invocations. Wrapping them in a `--step` would just move the same branching into TypeScript with no added value.

**Image (run if `IMAGE_PRESENT=false`):** build the agent container image — takes a few minutes the first time, one-off cost.

`pnpm exec tsx setup/index.ts --step container -- --runtime docker`

### 3. OneCLI

Check probe results and skip if `ONECLI_STATUS=healthy`.

OneCLI is the local vault that holds API keys and only releases them to agents when they need them.

`pnpm exec tsx setup/index.ts --step onecli`

### 4. Anthropic credential

Check probe results and skip if `ANTHROPIC_SECRET=true`.

The credential never travels through chat — the user generates it, registers it with OneCLI themselves, and the skill verifies.

**4a. Pick the source.** `AskUserQuestion`:

1. **Claude subscription (Pro/Max)** — "Generate a token via `claude setup-token` in another terminal."
2. **Anthropic API key** — "Use a pay-per-use key from console.anthropic.com/settings/keys."

**4b. Wait for the user to obtain the credential.** For subscription, have them run `claude setup-token` in another terminal. For API key, point them to the console URL above. Either way, they keep the token — just confirm when they have it.

**4c. Pick the registration path.** `AskUserQuestion` — substitute `${ONECLI_URL}` from the probe (or `.env`):

1. **Dashboard** — "Open ${ONECLI_URL} in a browser; add a secret of type `anthropic`, value = the token, host-pattern `api.anthropic.com`."
2. **CLI** — "Run in another terminal: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

Wait for the user's confirmation. If their reply happens to include a token (starts with `sk-ant-`), register it for them: `pnpm exec tsx setup/index.ts --step auth -- --create --value <TOKEN>`.

**4d. Verify.**

`pnpm exec tsx setup/index.ts --step auth -- --check`

If `ANTHROPIC_OK=false`, the secret isn't there yet — ask them to retry, then re-check.

### 5. Service

Check probe results and skip if `SERVICE_STATUS=running`.

Start the NanoClaw background service — it relays messages between the user and the agent.

`pnpm exec tsx setup/index.ts --step service`

### 6. Wire the CLI agent and verify end-to-end

**Do not narrate this step.** No "creating your first agent…", no "sending a ping…" chatter. The user's experience here is: they finished the last visible step (service), then a single success line appears. Wiring is an implementation detail at this point, not a user-facing milestone.

If step 2's container build is still running in the background, join it here before proceeding — the agent needs the image.

Use `INFERRED_DISPLAY_NAME` from the probe silently. **Do not ask the user.** The CLI agent at this stage is a scratch agent whose only purpose is to verify the end-to-end pipeline (host → container → agent → back). The user's real name capture happens in `/new-setup-2` when they wire a messaging channel.

Run wiring and ping back-to-back, silently:

```
pnpm exec tsx setup/index.ts --step cli-agent -- --display-name "<INFERRED_DISPLAY_NAME>"
pnpm run chat ping
```

First container spin-up takes ~60s. When the agent's reply arrives, emit exactly one line to the user:

> Your agent is up, running and ready to go!

If `pnpm run chat ping` times out or errors, tail `logs/nanoclaw.log`, diagnose, and fix — don't surface a half-success.

> **Loose command:** `pnpm run chat ping`. Justification: this is the same command the user will keep using after setup, so verification and the real channel are one and the same.

### 7. Chat now, or keep setting up?

Ask the user via `AskUserQuestion` which they'd like to do next:

1. **Keep chatting with the agent via CLI** — happy with the CLI channel for now.
2. **Continue setup** — name the agent, wire a messaging channel, add quality-of-life extras.

**If they pick "keep chatting":** print both options below, then stop. The user is chatting with the agent now, not with you — no further output from you.

**Option 1 — from inside this Claude Code session.** Type your message with a leading `!`, which runs it as a bash command in this shell:

```
!pnpm run chat your message here
```

**Option 2 — from a separate terminal.** Open a new terminal, `cd` into your nanoclaw checkout, then:

```
pnpm run chat your message here
```

**If they pick "continue setup":** hand off directly to `/new-setup-2` via the Skill tool. That follow-on flow is structured like this one (linear, skippable steps) and covers naming, messaging-channel wiring, and QoL. Invoke it immediately — do not offer a menu of individual skills.

## If anything fails

Any step that reports `STATUS: failed` in its status block: read `logs/setup.log`, diagnose, fix the underlying cause, re-run the same `--step`. Don't bypass errors to keep moving.
