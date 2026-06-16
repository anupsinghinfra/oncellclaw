---
name: add-discord
description: Add Discord bot channel integration via Chat SDK.
---

# Add Discord Channel

Adds Discord bot support via the Chat SDK bridge. NanoClaw doesn't ship channels
in trunk — this skill copies the Discord adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Discord adapter and its registration
test into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/discord.ts
src/channels/discord-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './discord.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/discord@4.26.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/discord-registration.test.ts
```

`discord-registration.test.ts` imports the real channel barrel and asserts the
registry contains `discord`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/discord` isn't installed
(the import throws) — so it also covers the dependency from step 3. End-to-end
delivery against a real server is verified manually once the service runs.

## Credentials

Discord app setup is human and interactive — these steps are prose, not
directives (no parser can click through the Discord Developer Portal). A recipe
rebuild produces a compiling, registered adapter that cannot receive a message
until they're done.

### Create Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name (e.g., "NanoClaw Assistant")
3. From the **General Information** tab, copy the **Application ID** and **Public Key**
4. Go to the **Bot** tab and click **Add Bot** if needed
5. Copy the Bot Token (click **Reset Token** if you need a new one — you can only see it once)
6. Under **Privileged Gateway Intents**, enable **Message Content Intent**
7. Go to **OAuth2** > **URL Generator**:
   - Scopes: select `bot`
   - Bot Permissions: select `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`, `Use Slash Commands`
8. Copy the generated URL and open it in your browser to invite the bot to your server

### Store the credentials

All three values are required — the adapter will fail to start without
`DISCORD_PUBLIC_KEY` and `DISCORD_APPLICATION_ID`. Capture them, then write them.
`prompt` only *asks* and binds the answer to a name; a separate directive
consumes it — so the same prompts could feed `ncl` or the OneCLI vault instead of
`.env` by swapping only the consumer. Here they go to `.env` (set-if-absent — a
value you've already filled in is never overwritten) and sync to the container:

```nc:prompt bot_token secret
Paste the Bot Token — Bot tab. Click `Reset Token` if you need a new one.
```
```nc:prompt application_id
Paste the Application ID — General Information tab.
```
```nc:prompt public_key
Paste the Public Key — General Information tab.
```
```nc:env-set
DISCORD_BOT_TOKEN={{bot_token}}
DISCORD_APPLICATION_ID={{application_id}}
DISCORD_PUBLIC_KEY={{public_key}}
```
```nc:env-sync
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise run
`/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `discord`
- **terminology**: Discord has "servers" (also called "guilds") containing "channels." Text channels start with #. The bot can also receive direct messages.
- **how-to-find-id**: Enable Developer Mode in Discord (Settings > App Settings > Advanced > Developer Mode). Then right-click a server and select "Copy Server ID" for the guild ID, and right-click the text channel and select "Copy Channel ID." The platform ID format used in registration is `discord:{guildId}:{channelId}` — both IDs are required.
- **supports-threads**: yes
- **typical-use**: Interactive chat — server channels or direct messages
- **default-isolation**: Same agent group for your personal server. Separate agent group for servers with different communities or where different members have different information boundaries.
