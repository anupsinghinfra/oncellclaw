---
name: add-imessage
description: Add iMessage channel integration via Chat SDK. Local (macOS) or remote (Photon API) mode.
---

# Add iMessage Channel

Adds iMessage support via the Chat SDK bridge. Two modes: local (macOS with Full
Disk Access) or remote (Photon API). NanoClaw doesn't ship channels in trunk —
this skill copies the iMessage adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads
the prose and applies them, and a parser can apply them deterministically from
the same document. Every directive is idempotent, so the whole skill is safe to
re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the iMessage adapter into `src/channels/`
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/imessage.ts
src/channels/imessage-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './imessage.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
chat-adapter-imessage@0.1.1
```

### 4. Build and validate

Build guards the typed `createChatSdkBridge(...)` core call and proves the
dependency is installed (the adapter's top-level `import` from
`chat-adapter-imessage` throws if it isn't):

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/imessage-registration.test.ts
```

`imessage-registration.test.ts` imports the real channel barrel and asserts the
registry contains `imessage` — it goes red if the import line is deleted or
drifts, if the barrel fails to evaluate, or if `chat-adapter-imessage` isn't
installed (the import throws), so it also covers the dependency from step 3.

End-to-end message delivery against a real iMessage account is verified manually
once the service is running — see Next Steps.

## Credentials

iMessage runs in one of two modes. Mode choice and the Full Disk Access /
Photon walkthrough are human and interactive — these steps stay prose, not
directives.

### Local Mode (macOS)

Requirements: macOS with Full Disk Access granted to the Node.js binary.

The Node binary path is buried deep (e.g. `~/.nvm/versions/node/v22.x.x/bin/node`). To make it easy, open the folder in Finder so the user can drag the file into System Settings:

```bash
open "$(dirname "$(which node)")"
```

Then tell the user:

1. Open **System Settings** > **Privacy & Security** > **Full Disk Access**
2. Click **+**, then drag the `node` file from the Finder window that just opened
3. Toggle it on

Stop and wait for the user to confirm before continuing.

### Remote Mode (Photon API)

1. Set up a [Photon](https://photon.codes) account
2. Get your server URL and API key

### Configure environment

The two modes use different `.env` keys. Write only the keys for the chosen
mode, and remove the opposite mode's keys so a stale value can't confuse the
adapter's factory.

**Local mode** — add to `.env` (and remove `IMESSAGE_SERVER_URL` /
`IMESSAGE_API_KEY` if present):

```bash
IMESSAGE_ENABLED=true
IMESSAGE_LOCAL=true
```

**Remote mode** — add to `.env` (and remove `IMESSAGE_ENABLED` if present):

```bash
IMESSAGE_LOCAL=false
IMESSAGE_SERVER_URL=https://your-photon-server.com
IMESSAGE_API_KEY=your-api-key
```

Once the keys for your mode are written, sync `.env` to the container (the host
mounts `data/env/env`):

```nc:env-sync
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `imessage`
- **terminology**: iMessage has "conversations." Each conversation is with a contact identified by phone number or email address. Group chats are also supported.
- **how-to-find-id**: The platform ID is the contact's phone number (e.g. `+15551234567`) or email address. For group chats, the ID is assigned by iMessage internally.
- **supports-threads**: no
- **typical-use**: Interactive 1:1 chat — personal messaging
- **default-isolation**: Same agent group if you're the only person messaging the bot across iMessage and other channels. Separate agent group if different contacts should have information isolation.
