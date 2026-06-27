---
name: add-slack
description: Add Slack channel integration via Chat SDK.
---

# Add Slack Channel

Adds Slack support via the Chat SDK bridge. NanoClaw doesn't ship channels in
trunk — this skill copies the Slack adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Slack adapter and its registration test
into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/slack.ts
src/channels/slack-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './slack.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/slack@4.26.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/slack-registration.test.ts
```

`slack-registration.test.ts` imports the real channel barrel and asserts the
registry contains `slack`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/slack` isn't installed (the
import throws) — so it also covers the dependency from step 3. End-to-end
delivery against a real workspace is verified manually once the service runs.

## Credentials

Slack app setup is human and interactive — these steps are prose, not directives
(no parser can click through the Slack UI). A recipe rebuild produces a
compiling, registered adapter that cannot receive a message until they're done.

### Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Name it (e.g. "NanoClaw") and select your workspace.
3. **OAuth & Permissions** → add Bot Token Scopes: `chat:write`, `im:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`, `reactions:write`, `files:read`, `files:write`.
4. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
5. **Basic Information** → copy the **Signing Secret**.

### Enable DMs

6. **App Home** → enable the **Messages Tab**.
7. Check **"Allow users to send Slash commands and messages from the messages tab."**

### Event Subscriptions & Interactivity

8. **Event Subscriptions** → **Enable Events**. Set the **Request URL** to your public `https://your-domain/webhook/slack` (see Webhook server); Slack sends a challenge that must pass before you can save.
9. Under **Subscribe to bot events**, add `message.channels`, `message.groups`, `message.im`, `app_mention`. **Save Changes**.
10. **Interactivity & Shortcuts** → toggle **Interactivity** on, set the same Request URL, **Save Changes**, then **reinstall** the app when Slack prompts.

### Store the credentials

Capture the two values, then write them. `prompt` only *asks* and binds the
answer to a name; a separate directive consumes it — so the same prompts could
feed `ncl` or the OneCLI vault instead of `.env` by swapping only the consumer.
Here they go to `.env` (set-if-absent — a value you've already filled in is
never overwritten) and sync to the container:

```nc:prompt bot_token secret
Paste the Bot User OAuth Token — OAuth & Permissions, starts with `xoxb-`.
```
```nc:prompt signing_secret secret
Paste the Signing Secret — Basic Information.
```
```nc:env-set
SLACK_BOT_TOKEN={{bot_token}}
SLACK_SIGNING_SECRET={{signing_secret}}
```
```nc:env-sync
```

### Webhook server

The Chat SDK bridge automatically starts a shared webhook server on port 3000
(`WEBHOOK_PORT` to change it), handling `/webhook/slack`. This port must be
publicly reachable for Slack to deliver events. Running locally, expose it with
ngrok (`ngrok http 3000`), a Cloudflare Tunnel, or a reverse proxy on a VPS —
the resulting public URL is the base for the Request URL above.

## Connect yourself

Wire your own Slack account as the owner so you can talk to the assistant, and
have it send you a hello. You'll need your Slack member ID: open your profile
(your avatar, bottom-left), then **⋮** → **Copy member ID** — it starts with `U`.
Pick which agent should answer you, too (`ncl groups list` shows their folders).

```nc:prompt slack_user_id
Your Slack member ID (Profile → ⋮ → "Copy member ID"; starts with U).
```
```nc:prompt agent_folder
Which agent should answer your Slack DMs? Enter its folder (run `ncl groups list`).
```

Confirm the bot token works — `auth.test` should come back `ok`:

```nc:run effect:fetch
curl -sf -X POST https://slack.com/api/auth.test -H "Authorization: Bearer {{bot_token}}" | jq -e .ok >/dev/null
```

The conversation address is your direct-message channel with the bot —
`slack:<channelId>`. Open the DM with `conversations.open` and take the channel
id it returns (if Slack returns no channel, the bot is missing the `im:write`
scope — add it and reinstall):

```nc:run capture:dm_channel effect:fetch
curl -s -X POST https://slack.com/api/conversations.open -H "Authorization: Bearer {{bot_token}}" -H "Content-Type: application/json" -d '{"users":"{{slack_user_id}}"}' | jq -er .channel.id
```

Register yourself as the owner, wire your DM to the agent so it answers every
message, and send a greeting:

```nc:run effect:wire
ncl users create --id slack:{{slack_user_id}} --kind slack --display-name Owner
ncl roles grant --user slack:{{slack_user_id}} --role owner
ncl messaging-groups create --channel-type slack --platform-id slack:{{dm_channel}} --is-group 0
ncl wirings create --channel-type slack --platform-id slack:{{dm_channel}} --agent-group {{agent_folder}} --engage-mode pattern --engage-pattern .
ncl messaging-groups send --channel-type slack --platform-id slack:{{dm_channel}} --sender-id slack:{{slack_user_id}} --sender Owner --text "Hi — I'm your NanoClaw assistant. Say anything to get started."
```

The greeting goes out over `chat.postMessage`, which works right away. To receive
replies, finish the Event Subscriptions and Interactivity steps above so Slack
can reach the webhook.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

## Channel Info

- **type**: `slack`
- **terminology**: Slack has "workspaces" containing "channels." Channels can be public (#general) or private. The bot can also receive direct messages.
- **platform-id-format**: `slack:{channelId}` for channels (e.g., `slack:C0123ABC`), `slack:{dmId}` for DMs (e.g., `slack:D0ARWEBLV63`)
- **how-to-find-id**: Right-click a channel name > "View channel details" — the Channel ID is at the bottom (starts with C). For DMs, the ID starts with D. Or copy the channel link — the ID is the last segment of the URL.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team channels or direct messages
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or sensitive contexts.
