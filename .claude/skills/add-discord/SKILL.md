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

Discord app setup is human and interactive — no parser can click through the
Discord Developer Portal. The adapter is installed and registered, but it can't
receive a message until the bot exists, has Message Content Intent, and shares a
server with you. Tell the user:

```nc:operator
Create the Discord bot:
1. Go to https://discord.com/developers/applications → New Application. Name it (e.g. "NanoClaw Assistant").
2. General Information → copy the Application ID and the Public Key.
3. Bot tab → Add Bot if needed → Reset Token, then copy the Bot Token (it's shown only once).
4. Bot tab → Privileged Gateway Intents → enable Message Content Intent.
5. OAuth2 → URL Generator → Scopes: bot; Bot Permissions: Send Messages, Read Message History, Add Reactions, Attach Files, Use Slash Commands.
6. Open the generated URL and invite the bot to a server you're also in (a personal server is fine) — the bot can only DM you once you share a server.
```

Collect the three values and store them — the adapter reads them from `.env` and
fails to start without `DISCORD_PUBLIC_KEY` and `DISCORD_APPLICATION_ID`. They go
to `.env` (set-if-absent — a value you've already filled in is never
overwritten) and sync to the container:

```nc:prompt bot_token secret validate:^[A-Za-z0-9._-]{50,}$
Paste the Bot Token — Bot tab. Click `Reset Token` if you need a new one.
```
```nc:prompt application_id validate:^\d{17,20}$
Paste the Application ID — General Information tab.
```
```nc:prompt public_key validate:^[a-fA-F0-9]{64}$
Paste the Public Key — General Information tab.
```
```nc:env-set
DISCORD_BOT_TOKEN={{bot_token}}
DISCORD_APPLICATION_ID={{application_id}}
DISCORD_PUBLIC_KEY={{public_key}}
```
```nc:env-sync
```

## Restart

Restart the service so it loads the Discord adapter and the credentials you just
stored, and wait for its CLI socket before resolving:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Resolve your DM channel

The agent talks to you in your direct-message channel with the bot. Resolve its
address so the owner-wiring step can target it. You'll need your Discord user ID:
open **Settings → Advanced → Developer Mode** on, then right-click your own
name and **Copy User ID** — it's 17–20 digits.

```nc:prompt owner_handle validate:^\d{17,20}$
Your Discord user ID (Settings → Advanced → Developer Mode on, then right-click your name → "Copy User ID"; 17–20 digits).
```

Confirm the bot token works and capture the bot identity — `/users/@me` returns
the bot user and fails here if the token is bad:

```nc:run capture:connected_as effect:fetch
curl -sf https://discord.com/api/v10/users/@me -H "Authorization: Bot {{bot_token}}" | jq -er '"@" + .username'
```

Open the DM with `POST /users/@me/channels` and take the channel id it returns as
the conversation address `discord:@me:<channelId>` (if Discord refuses, the bot
doesn't share a server with you yet — invite it, then retry):

```nc:run capture:platform_id effect:fetch
curl -s -X POST https://discord.com/api/v10/users/@me/channels -H "Authorization: Bot {{bot_token}}" -H "Content-Type: application/json" -d '{"recipient_id":"{{owner_handle}}"}' | jq -er '"discord:@me:" + .id'
```

`owner_handle` and `platform_id` are what the owner-wiring step needs. The
greeting goes out over the DM channel, which works as soon as the bot shares a
server with you.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`).

## Channel Info

- **type**: `discord`
- **terminology**: Discord has "servers" (also called "guilds") containing "channels." Text channels start with #. The bot can also receive direct messages.
- **platform-id-format**: `discord:@me:{dmChannelId}` for the owner DM (e.g. `discord:@me:1399...`), `discord:{guildId}:{channelId}` for server channels — both IDs required for channels.
- **how-to-find-id**: Enable Developer Mode in Discord (Settings > App Settings > Advanced > Developer Mode). Then right-click a server and select "Copy Server ID" for the guild ID, and right-click the text channel and select "Copy Channel ID." The platform ID format used in registration is `discord:{guildId}:{channelId}` — both IDs are required.
- **supports-threads**: yes
- **typical-use**: Interactive chat — server channels or direct messages
- **default-isolation**: Same agent group for your personal server. Separate agent group for servers with different communities or where different members have different information boundaries.
