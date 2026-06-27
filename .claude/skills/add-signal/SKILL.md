---
name: add-signal
description: Add Signal channel integration via signal-cli device-link. Native adapter — no Chat SDK bridge.
---

# Add Signal Channel

Adds Signal support via a native adapter that speaks JSON-RPC to a
[signal-cli](https://github.com/AsamK/signal-cli) daemon — no Chat SDK bridge,
only Node.js builtins. NanoClaw links to Signal as a *secondary device* on your
existing phone: no new number, no bot API. Your assistant sends and receives as
the number on the phone that scans the link.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads
the prose and applies them, and a parser can apply them deterministically from
the same document. Every directive is idempotent, so the whole skill is safe to
re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Install signal-cli

NanoClaw talks to Signal through signal-cli, which has no bot API of its own.
Install it if it isn't on PATH yet — Homebrew on macOS, the native release binary
on Linux (neither needs Java). If it's already installed this is a no-op:

```nc:run effect:external
command -v signal-cli >/dev/null 2>&1 || bash setup/install-signal-cli.sh
```

### 2. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Signal adapter and its registration test
into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/signal.ts
src/channels/signal-registration.test.ts
```

### 3. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line is
already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './signal.js';
```

### 4. Install the QR-rendering dependency

The device-link step renders the linking URL as a terminal QR via `qrcode`.
Pinned to exact versions — the supply-chain policy rejects ranges and `latest`:

```nc:dep
qrcode@1.5.4
@types/qrcode@1.5.6
```

The adapter itself consumes only Node.js builtins, so there is no adapter package
to install — `qrcode` is purely for rendering the link during setup.

### 5. Build and validate

Build first: it guards the adapter's typed core-API consumption. Then run the one
integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/signal-registration.test.ts
```

`signal-registration.test.ts` imports the real channel barrel and asserts the
registry contains `signal`. It goes red if the `import './signal.js';` line is
deleted or drifts, or if the barrel fails to evaluate — so the channel genuinely
would not register. The adapter has no npm dependency to guard; its typed
core-API consumption is covered by the build. End-to-end delivery against a real
Signal account is verified manually once the service runs.

## Link your Signal account

This is the whole credential step. signal-cli opens a device-link handshake,
prints a `sgnl://linkdevice…` URL, and renders it as a scannable QR. You scan it
once from the phone that already runs Signal; that phone's number becomes the
account NanoClaw sends and receives as — no number is registered.

The device-link runs signal-cli, so it must be reachable first — on `PATH`, or at
`$SIGNAL_CLI_PATH`. If step 1's install didn't land, the link step has nothing to
drive; confirm it's present before linking (re-run step 1 if this fails):

```nc:run effect:check
command -v signal-cli >/dev/null 2>&1 || [ -x "$SIGNAL_CLI_PATH" ]
```

Tell the user:

```nc:operator
Link NanoClaw to your Signal account:
1. On the phone that runs Signal, open Signal → Settings → Linked Devices → Link New Device.
2. Scan the QR code shown below — or open the `sgnl://linkdevice…` link printed under it on that phone.
3. Wait for confirmation. The linking URL expires after ~3 minutes; re-run this step for a fresh one.
```

Run the device-link. It blocks until you scan, then reports the linked phone
number back as the account — that number is both your owner handle and the
conversation address the wiring step needs:

```nc:run effect:step capture:platform_id=ACCOUNT,owner_handle=ACCOUNT
pnpm exec tsx setup/index.ts --step signal-auth
```

`owner_handle` and `platform_id` both come back as the bare phone number (e.g.
`+15551234567`). Your assistant reaches you through Signal's Note to Self, so the
owner conversation is addressed by your own number — not a per-contact UUID.

## Persist the account

Store the linked number so the adapter binds the right account on start, then sync
it into the container env:

```nc:env-set
SIGNAL_ACCOUNT={{platform_id}}
```
```nc:env-sync
```

## Restart

Restart the service so it loads the Signal adapter and binds the account you just
linked, and wait for its CLI socket before wiring:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`).

## Channel Info

- **type**: `signal`
- **terminology**: Signal has "chats" (1:1 DMs) and "groups." The owner reaches their own assistant through Note to Self.
- **platform-id-format**:
  - Owner DM (Note to Self): the bare phone number `+<number>` (e.g. `+15551234567`) — your own messages route back as inbound with `isFromMe`, addressed by your number.
  - Third-party DM: `signal:{UUID}` — the sender's Signal ACI, **not** their phone number.
  - Group: `signal:{base64GroupId}` — base64-encoded GroupV2 ID.
- **how-to-find-id**: The owner number comes back from the device-link step above. For third parties or groups, send a message to the bot, then query `messaging_groups`.
- **supports-threads**: no
- **typical-use**: Personal assistant via Signal DMs or small group chats
- **default-isolation**: One agent per Signal account. Multiple chats with the same operator can share an agent group; groups with other people should typically use `isolated` session mode.

### Features

- Markdown formatting — `**bold**`, `*italic*` / `_italic_`, `` `code` ``, ` ```code fence``` `, `~~strike~~`, `||spoiler||` (converted to Signal's offset-based text styles).
- Quoted replies — `replyTo*` fields populated from Signal quotes.
- Typing indicators — DMs only (Signal doesn't support group typing).
- Note to Self — messages you send to your own account from another device route to the agent as inbound with `isFromMe: true`.
- Voice attachments — detected but not transcribed by default; the agent receives a `[Voice Message]` placeholder. Run `/add-voice-transcription` for local transcription.

Not supported yet: outbound file attachments (logged and dropped), edit/delete messages, reactions.

## Troubleshooting

### Daemon not reachable

```bash
grep "Signal" logs/nanoclaw.log | tail
```

If you see `Signal daemon failed to start. Is signal-cli installed and your account linked?`, confirm `signal-cli` is on PATH (or set `SIGNAL_CLI_PATH`) and that the account is linked — `signal-cli -a +YOURNUMBER listIdentities` should succeed without prompting.

### Messages dropped with `not_member`

New Signal senders — including the owner's Signal identity — are gated until granted access. `/init-first-agent` grants the owner automatically; for other users, wire access with `/manage-channels` after their first message appears in `messaging_groups`.

### Config file in use / daemon lock

signal-cli holds an exclusive lock on its data directory while the daemon runs. Stop NanoClaw before running any `signal-cli` command directly, then restart afterward.

### Linking URL expired

The `sgnl://linkdevice…` URL expires after a few minutes. Re-run the device-link step to get a fresh QR.
