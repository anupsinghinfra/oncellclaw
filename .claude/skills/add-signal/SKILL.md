---
name: add-signal
description: Add Signal channel integration via signal-cli TCP daemon. Native adapter — no Chat SDK bridge.
---

# Add Signal Channel

Adds Signal messaging support via a native adapter that communicates with a [signal-cli](https://github.com/AsamK/signal-cli) TCP daemon using JSON-RPC.

## Prerequisites

- **signal-cli** installed and a Signal account linked
  - macOS: `brew install signal-cli`
  - Linux: download from [GitHub releases](https://github.com/AsamK/signal-cli/releases)
  - Link your account: `signal-cli -a +1YOURNUMBER link` (follow the QR instructions)

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/signal.ts` exists
- `src/channels/signal.test.ts` exists
- `src/channels/index.ts` contains `import './signal.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the skill branch

```bash
git fetch origin skill/signal
```

### 2. Copy the adapter and tests

```bash
git show origin/skill/signal:src/channels/signal.ts > src/channels/signal.ts
git show origin/skill/signal:src/channels/signal.test.ts > src/channels/signal.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './signal.js';
```

### 4. Build

```bash
pnpm run build
```

No npm packages to install — the adapter uses only Node.js builtins (`node:net`, `node:child_process`, `node:fs`).

## Credentials

Add to `.env`:

```env
SIGNAL_ACCOUNT=+1YOURNUMBER
```

### Optional settings

```env
# TCP daemon host and port (default: 127.0.0.1:7583)
SIGNAL_HTTP_HOST=127.0.0.1
SIGNAL_HTTP_PORT=7583

# Whether NanoClaw manages the daemon lifecycle (default: true)
# Set to false if you run signal-cli daemon externally
SIGNAL_MANAGE_DAEMON=true

# signal-cli data directory (default: ~/.local/share/signal-cli)
SIGNAL_DATA_DIR=~/.local/share/signal-cli
```

### Sync to container

```bash
mkdir -p data/env && cp .env data/env/env
```

### Restart

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Next Steps

Run `/init-first-agent` to create an agent and wire it to your Signal DM. Signal is direct-addressable — your phone number is the platform ID:

- **User ID**: your Signal phone number (e.g. `+15551234567`)
- **Platform ID**: same as user ID for DMs (e.g. `+15551234567`)
- **For group chats**: use `group:<groupId>` — find group IDs via `signal-cli -a +1YOURNUMBER listGroups`

`/init-first-agent` handles user creation, owner role, agent group, messaging group wiring, and the welcome DM. It's idempotent — safe to run again for additional agents.

## Channel Info

| Field | Value |
|-------|-------|
| **Type** | `signal` |
| **Thread support** | No (Signal has no thread model) |
| **Platform ID format** | DM: `+15555550123` / Group: `group:<groupId>` |
| **Mention detection** | Text-match against agent group name (no SDK-level mentions) |
| **Typing indicators** | DMs only |
| **Typical use** | Personal assistant via Signal DMs or small group chats |
| **Isolation** | Recommended: one agent per Signal account |

### Voice Messages

Voice attachments are detected but not transcribed by default. The agent receives `[Voice Message]` as the message text. Run `/add-voice-transcription` to enable automatic local transcription via parakeet-mlx.
