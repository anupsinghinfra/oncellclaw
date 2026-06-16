---
name: add-telegram
description: Add Telegram channel integration via Chat SDK.
---

# Add Telegram Channel

Adds Telegram bot support via the Chat SDK bridge. NanoClaw doesn't ship
channels in trunk — this skill copies the Telegram adapter, its
formatting/pairing helpers, their tests, and the `pair-telegram` setup step in
from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter, helpers, tests, and setup step

Fetch the `channels` branch and copy the Telegram adapter, its pairing and
markdown-sanitize helpers (with their tests), and the `pair-telegram` setup step
into place (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/telegram.ts
src/channels/telegram-pairing.ts
src/channels/telegram-pairing.test.ts
src/channels/telegram-markdown-sanitize.ts
src/channels/telegram-markdown-sanitize.test.ts
src/channels/telegram-registration.test.ts
setup/pair-telegram.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './telegram.js';
```

### 3. Register the setup step

Add the `pair-telegram` loader to the `STEPS` map in `setup/index.ts`, inside the
dormant marker region (skipped if already present — `pair-telegram` ships in core,
so this idempotent-skips on a normal install, but is expressed for a
clean-upstream rebuild):

```nc:append to:setup/index.ts at:nanoclaw:setup-steps
'pair-telegram': () => import('./pair-telegram.js'),
```

### 4. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/telegram@4.26.0
```

### 5. Build and validate

Build guards the typed `createChatSdkBridge(...)` core call and proves the
dependency is installed — it goes red if the `import './telegram.js';` line is
deleted or drifts, if the barrel fails to evaluate, or if
`@chat-adapter/telegram` isn't installed (the import throws):

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/telegram-registration.test.ts
```

`telegram-registration.test.ts` imports the real channel barrel and asserts the
registry contains `telegram` — it goes red if the `import './telegram.js';` line
is deleted or drifts, if the barrel fails to evaluate, or if
`@chat-adapter/telegram` isn't installed (the import throws), so it also covers
the dependency from step 4.

End-to-end message delivery against a real Telegram bot is verified manually once
the service is running — see Next Steps and the pairing flow in Channel Info.

## Credentials

Bot creation in Telegram is human and interactive — these steps are prose, not
directives (no parser can click through BotFather). A recipe rebuild produces a
compiling, registered adapter that cannot receive a message until they're done.

### Create Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts:
   - Bot name: Something friendly (e.g., "NanoClaw Assistant")
   - Bot username: Must end with "bot" (e.g., "nanoclaw_bot")
3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

**Important for group chats**: By default, Telegram bots only see @mentions and commands in groups. To let the bot see all messages:

1. Open `@BotFather` > `/mybots` > select your bot
2. **Bot Settings** > **Group Privacy** > **Turn off**

### Store the credentials

Capture the bot token, then write it. `prompt` only *asks* and binds the answer
to a name; a separate directive consumes it — so the same prompt could feed `ncl`
or the OneCLI vault instead of `.env` by swapping only the consumer. Here it goes
to `.env` (set-if-absent — a value you've already filled in is never overwritten)
and syncs to the container:

```nc:prompt bot_token secret
Paste the bot token from BotFather (looks like `123456:ABC-DEF...`).
```
```nc:env-set
TELEGRAM_BOT_TOKEN={{bot_token}}
```
```nc:env-sync
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `telegram`
- **terminology**: Telegram calls them "groups" and "chats." A "group" has multiple members; a "chat" is a 1:1 conversation with the bot.
- **how-to-find-id**: Do NOT ask the user for a chat ID. Telegram registration uses pairing — run `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent <main|wire-to:folder|new-agent:folder>`, show the user the 4-digit `CODE` from the `PAIR_TELEGRAM_ISSUED` block (follow the `REMINDER_TO_ASSISTANT` line in that block), and tell them to send just the 4 digits as a message from the chat they want to register (DM the bot for `main`, post in the group otherwise). In groups with Group Privacy ON, prefix with the bot handle: `@<botname> CODE`. Wrong guesses invalidate the code — if a `PAIR_TELEGRAM_ATTEMPT` block arrives with a mismatched `RECEIVED_CODE`, a `PAIR_TELEGRAM_NEW_CODE` block will follow automatically (up to 5 regenerations); show the new code. On `PAIR_TELEGRAM STATUS=failed ERROR=max-regenerations-exceeded`, ask the user if they want to try again and re-invoke the step — each invocation starts a fresh 5-attempt batch. Success emits `PAIR_TELEGRAM STATUS=success` with `PLATFORM_ID`, `IS_GROUP`, and `ADMIN_USER_ID`. The service must be running for this to work (the polling adapter is what observes the code).
- **supports-threads**: no
- **typical-use**: Interactive chat — direct messages or small groups
- **default-isolation**: Same agent group if you're the only participant across multiple chats. Separate agent group if different people are in different groups.
