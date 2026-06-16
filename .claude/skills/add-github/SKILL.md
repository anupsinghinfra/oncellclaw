---
name: add-github
description: Add GitHub channel integration via Chat SDK. PR and issue comment threads as conversations.
---

# Add GitHub Channel

Adds GitHub support via the Chat SDK bridge. The agent participates in PR and
issue comment threads. NanoClaw doesn't ship channels in trunk — this skill
copies the GitHub adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Prerequisites

You need a **dedicated GitHub bot account** (not your personal account). The adapter uses this account to post replies and filters out its own messages to avoid loops. Create a free GitHub account for your bot (e.g. `my-org-bot`), then invite it as a collaborator with write access to the repos you want monitored.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the GitHub adapter into `src/channels/`
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/github.ts
src/channels/github-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './github.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/github@4.26.0
```

### 4. Build and validate

The build guards the typed `createChatSdkBridge(...)` core call and proves the
dependency is installed (the adapter import throws if `@chat-adapter/github`
isn't present):

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/github-registration.test.ts
```

`github-registration.test.ts` imports the real channel barrel and asserts the
registry contains `github`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/github` isn't installed
(the import throws) — so it also covers the dependency from step 3.

End-to-end message delivery against a real GitHub repo is verified manually once
the service is running — see Next Steps and the webhook setup below.

## Credentials

### 1. Create a Personal Access Token for the bot account

Log in as your **bot account**, then:

1. Go to [Settings > Developer Settings > Personal Access Tokens](https://github.com/settings/tokens)
2. Create a **Fine-grained token** with:
   - Repository access: select the repos you want the bot to monitor
   - Permissions: **Pull requests** (Read & Write), **Issues** (Read & Write)
3. Copy the token

### 2. Set up a webhook on each repo

On each repo (logged in as the repo owner/admin):

1. Go to **Settings** > **Webhooks** > **Add webhook**
2. Payload URL: `https://your-domain/webhook/github` (the shared webhook server, default port 3000)
3. Content type: `application/json`
4. Secret: generate a random string (e.g. `openssl rand -hex 20`)
5. Events: select **Issue comments** and **Pull request review comments**

### 3. Configure environment

Capture the three values, then write them. `prompt` only *asks* and binds the
answer to a name; a separate directive consumes it — so the same prompts could
feed `ncl` or the OneCLI vault instead of `.env` by swapping only the consumer.
Here they go to `.env` (set-if-absent — a value you've already filled in is
never overwritten) and sync to the container:

```nc:prompt github_token secret
Paste the Fine-grained Personal Access Token for the bot account — starts with `github_pat_`.
```
```nc:prompt webhook_secret secret
Paste the webhook secret you generated for the repo webhook(s).
```
```nc:prompt bot_username
Enter the bot account's GitHub username exactly (used for @-mention detection).
```
```nc:env-set
GITHUB_TOKEN={{github_token}}
GITHUB_WEBHOOK_SECRET={{webhook_secret}}
GITHUB_BOT_USERNAME={{bot_username}}
```
```nc:env-sync
```

`GITHUB_BOT_USERNAME` must match the bot account's GitHub username exactly. This is used for @-mention detection — the agent responds when someone writes `@your-bot-username` in a PR or issue comment.

## Wiring

Ask the user: **Is this a private or public repo?**

- **Private repo** — use `unknown_sender_policy: 'public'`. Only collaborators can comment anyway, so it's safe to let all comments through.
- **Public repo** — use `unknown_sender_policy: 'strict'`. Only registered members can trigger the agent, preventing strangers from consuming agent resources. Add trusted collaborators as members (see below).

Run `/manage-channels` to wire the GitHub channel to an agent group, or insert manually:

```sql
-- Create messaging group (one per repo)
INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
VALUES ('mg-github-myrepo', 'github', 'github:owner/repo', 'github', 'owner/repo', 1, '<policy>', datetime('now'));

-- Wire to agent group
INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, trigger_rules, response_scope, session_mode, priority, created_at)
VALUES ('mga-github-myrepo', 'mg-github-myrepo', '<your-agent-group-id>', '', 'all', 'per-thread', 10, datetime('now'));
```

Replace `<policy>` with `public` or `strict` based on the user's choice above.

### Adding members (for strict mode)

When using `strict`, add each GitHub user who should be able to trigger the agent:

```sql
-- Add user (kind = 'github', id = 'github:<numeric-user-id>')
INSERT OR IGNORE INTO users (id, kind, display_name, created_at)
VALUES ('github:<user-id>', 'github', '<username>', datetime('now'));

-- Grant membership to the agent group
INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id)
VALUES ('github:<user-id>', '<agent-group-id>');
```

To find a GitHub user's numeric ID: `gh api users/<username> --jq .id`

Use `per-thread` session mode so each PR/issue gets its own agent session.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, restart the service to pick up the new channel.

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

## Channel Info

- **type**: `github`
- **terminology**: GitHub has "repositories" containing "pull requests" and "issues." Each PR or issue comment thread is a separate conversation.
- **how-to-find-id**: The platform ID is `github:owner/repo` (e.g. `github:acme/backend`). Each PR/issue becomes its own thread automatically.
- **supports-threads**: yes (PR and issue comment threads are native conversations)
- **typical-use**: Webhook-driven — the agent receives PR and issue comment events and responds in comment threads when @-mentioned. After the first mention, the thread is subscribed and the agent responds to all follow-up comments.
- **default-isolation**: Use `per-thread` session mode. Each PR or issue gets its own isolated agent session. Typically wire to a dedicated agent group if the repo contains sensitive code.
