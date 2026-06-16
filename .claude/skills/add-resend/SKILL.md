---
name: add-resend
description: Add Resend (email) channel integration via Chat SDK.
---

# Add Resend Email Channel

Connect NanoClaw to email via Resend for async email conversations. NanoClaw
doesn't ship channels in trunk — this skill copies the Resend adapter in from the
`channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads
the prose and applies them, and a parser can apply them deterministically from
the same document. Every directive is idempotent, so the whole skill is safe to
re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the Resend adapter into `src/channels/`
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/resend.ts
src/channels/resend-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './resend.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@resend/chat-sdk-adapter@0.1.1
```

### 4. Build and validate

Build guards the typed `createChatSdkBridge(...)` core call and proves the
dependency is installed (the adapter imports `@resend/chat-sdk-adapter`; if it
isn't installed the barrel throws). End-to-end email delivery against a real
domain is verified manually once the service runs.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/resend-registration.test.ts
```

`resend-registration.test.ts` imports the real channel barrel and asserts the
registry contains `resend`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@resend/chat-sdk-adapter` isn't installed
(the import throws) — so it also covers the dependency from step 3.

## Credentials

Resend account and domain setup is human and interactive — these steps are
prose, not directives (no parser can verify a sending domain or click through the
Resend UI). A recipe rebuild produces a compiling, registered adapter that cannot
receive a message until they're done.

1. Go to [resend.com](https://resend.com) and create an account.
2. Add and verify your sending domain.
3. Go to **API Keys** and create a new key.
4. Set up a webhook:
   - Go to **Webhooks** > **Add webhook**.
   - URL: `https://your-domain/webhook/resend`.
   - Events: select **email.received**.
   - Copy the signing secret.

### Store the credentials

Capture the secrets, then write them. `prompt` only *asks* and binds the answer
to a name; a separate directive consumes it — so the same prompts could feed
`ncl` or the OneCLI vault instead of `.env` by swapping only the consumer. Here
they go to `.env` (set-if-absent — a value you've already filled in is never
overwritten) and sync to the container:

```nc:prompt api_key secret
Paste the Resend API key — API Keys, starts with `re_`.
```
```nc:prompt webhook_secret secret
Paste the webhook signing secret — Webhooks, the value you copied above.
```
```nc:prompt from_address
The bot's sending email address on your verified domain (e.g. `bot@yourdomain.com`).
```
```nc:prompt from_name
The display name to send as (e.g. `NanoClaw`).
```
```nc:env-set
RESEND_API_KEY={{api_key}}
RESEND_FROM_ADDRESS={{from_address}}
RESEND_FROM_NAME={{from_name}}
RESEND_WEBHOOK_SECRET={{webhook_secret}}
```
```nc:env-sync
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise run
`/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `resend`
- **terminology**: Resend handles email. Each email thread (identified by subject/In-Reply-To headers) is a separate conversation. The "from address" is the bot's identity.
- **how-to-find-id**: The platform ID is the from email address (e.g. `bot@yourdomain.com`). Each sender's email thread becomes its own conversation.
- **supports-threads**: yes (via email threading headers -- replies to the same thread stay together)
- **typical-use**: Async communication -- email conversations with longer response expectations
- **default-isolation**: Same agent group if you want your agent to handle email alongside other channels. Separate agent group if email contains sensitive correspondence that shouldn't be accessible from other channels.
