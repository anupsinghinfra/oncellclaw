---
name: add-whatsapp
description: Add WhatsApp channel via native Baileys adapter. Direct connection — no Chat SDK bridge. Uses QR code or pairing code for authentication.
---

# Add WhatsApp Channel

Adds WhatsApp support via the native Baileys adapter — a direct WhatsApp Web
connection, no Chat SDK bridge. NanoClaw doesn't ship channels in trunk — this
skill copies the WhatsApp adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the WhatsApp adapter and its registration
test into `src/channels/` (overwrite — the branch is canonical). The
`whatsapp-auth` setup step is maintained in trunk, so it is not copied here:

```nc:copy from-branch:channels
src/channels/whatsapp.ts
src/channels/whatsapp-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './whatsapp.js';
```

### 3. Install the adapter packages

Pinned to exact versions — the supply-chain policy rejects ranges and `latest`.
Baileys is the WhatsApp Web client; `qrcode` renders the device-link QR in the
terminal; `pino` is Baileys' logger:

```nc:dep
@whiskeysockets/baileys@7.0.0-rc.9
qrcode@1.5.4
@types/qrcode@1.5.6
pino@9.6.0
```

### 4. Build and validate

Build first: it typechecks the adapter against core and proves the dependencies
are installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/whatsapp-registration.test.ts
```

`whatsapp-registration.test.ts` imports the real channel barrel and asserts the
registry contains `whatsapp`. It goes red if the `import './whatsapp.js';` line
is deleted or drifts, if the barrel fails to evaluate, or if
`@whiskeysockets/baileys` isn't installed (the import throws) — so it also covers
the dependency from step 3. End-to-end delivery against a real WhatsApp number is
verified manually once the service runs.

## Authenticate

WhatsApp uses linked-device authentication — no API key, just a one-time pairing
from your phone. The adapter is installed and registered, but its factory returns
`null` (and the channel stays dark) until `store/auth/creds.json` exists.

Pick how to link the device. `qr` shows a rotating QR you scan with your phone's
camera; `pairing-code` shows an 8-character code you type into WhatsApp (no camera
needed, but it needs your phone number):

```nc:prompt auth_method validate:^(qr|pairing-code)$
How do you want to link WhatsApp? Type `qr` to scan a QR code in this terminal, or `pairing-code` to enter a code on your phone (no camera needed).
```

The pairing-code method needs the number you're linking, the way WhatsApp expects
it — digits only, country code first, no `+`, spaces, or dashes (the QR method
skips this entirely):

```nc:prompt phone validate:^\d{8,15}$ when:auth_method=pairing-code
Your WhatsApp phone number — digits only, country code first (e.g. 14155551234 for +1 415-555-1234).
```

Point the user at the right screen before the code appears. For the QR method,
tell the user:

```nc:operator when:auth_method=qr
Link WhatsApp by QR:
1. On your phone, open WhatsApp → Settings → Linked Devices → Link a Device.
2. A QR code will appear in this terminal below and refresh every ~20 seconds. Point your phone's camera at it to scan.
```

For the pairing-code method, tell the user:

```nc:operator when:auth_method=pairing-code
Link WhatsApp by pairing code:
1. On your phone, open WhatsApp → Settings → Linked Devices → Link a Device → tap "Link with phone number instead".
2. An 8-character code will appear in this terminal below. Enter it on your phone immediately — it expires in about 60 seconds.
```

Now run the linked-device handshake. It streams the live QR (or the pairing-code
card) to this terminal and, on success, reports the linked WhatsApp number. Run
the command for the method chosen above — `qr` or `pairing-code`:

```nc:run effect:step capture:bot_phone=PHONE when:auth_method=qr
pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr
```
```nc:run effect:step capture:bot_phone=PHONE when:auth_method=pairing-code
pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone {{phone}}
```

If the handshake fails (`logged_out` or a timeout), the code expired — clear
`store/auth/` and run the step again for a fresh one. See Troubleshooting.

A successful link reports the number back as `bot_phone`. If it came back empty,
the device never confirmed (an expired QR or pairing code), so don't restart or
wire against a blank number — clear `store/auth/` and re-run the link step first:

```nc:run effect:check
[ -n "{{bot_phone}}" ]
```

## Restart

Restart the service so it loads the WhatsApp adapter and picks up the
credentials you just linked, and wait for its CLI socket before resolving:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Resolve your DM channel

The agent talks to you in your WhatsApp chat. Tell the user which number that
chat happens on — usually the same one they just linked:

```nc:operator
You're linked to WhatsApp as +{{bot_phone}}.

- "shared" — you'll message the assistant from this same (personal) WhatsApp number. Replies land in your own "You" / self-chat.
- "dedicated" — the assistant has its own separate phone/SIM, and you'll message it from a different number.
```

Pick which it is. Most people use `shared`:

```nc:prompt number_kind validate:^(shared|dedicated)$
Is the assistant on a `shared` number (your personal WhatsApp) or a `dedicated` number (a separate line for the assistant)?
```

For a dedicated number, collect the number you'll actually chat from (skipped
entirely for a shared number):

```nc:prompt chat_phone validate:^\d{8,15}$ when:number_kind=dedicated
The phone number you'll message the assistant from — digits only, country code first (e.g. 14155551234).
```

A dedicated number means the assistant owns its own line, so outbound replies
shouldn't be prefixed with its name. Record that (skipped for a shared number):

```nc:env-set when:number_kind=dedicated
ASSISTANT_HAS_OWN_NUMBER=true
```
```nc:env-sync when:number_kind=dedicated
```

Resolve the conversation address as the WhatsApp JID for the number you chat
from — the linked number for a shared account, or the dedicated number you just
gave. Run the one matching the choice above:

```nc:run capture:platform_id effect:fetch when:number_kind=shared
echo "{{bot_phone}}@s.whatsapp.net"
```
```nc:run capture:platform_id effect:fetch when:number_kind=dedicated
echo "{{chat_phone}}@s.whatsapp.net"
```

For WhatsApp, your owner handle is that same JID:

```nc:run capture:owner_handle effect:fetch
echo "{{platform_id}}"
```

`owner_handle` and `platform_id` are what the owner-wiring step needs. The
greeting goes out over your WhatsApp chat as soon as the service reconnects with
the linked credentials.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`).

## Channel Info

- **type**: `whatsapp`
- **terminology**: WhatsApp calls them "groups" and "chats." A "chat" is a 1:1 DM; a "group" has multiple members.
- **platform-id-format**: DMs use `<phone>@s.whatsapp.net` (e.g. `14155551234@s.whatsapp.net`). Groups use `<id>@g.us`. Native adapter — the JID is the platform ID as-is, no `whatsapp:` prefix.
- **how-to-find-id**: To find your linked number after auth: `node -e "const c=JSON.parse(require('fs').readFileSync('store/auth/creds.json','utf-8'));console.log(c.me?.id?.split(':')[0].split('@')[0]+'@s.whatsapp.net')"`. Groups are auto-discovered — check `pnpm exec tsx scripts/q.ts data/v2.db "SELECT platform_id, name FROM messaging_groups WHERE channel_type='whatsapp' AND is_group=1"`.
- **supports-threads**: no
- **typical-use**: Interactive chat — direct messages or small groups
- **default-isolation**: Same agent group if you're the only participant across multiple chats. Separate agent group if different people are in different groups.

### Features

- Markdown formatting — `**bold**`→`*bold*`, `*italic*`→`_italic_`, headings→bold, code blocks preserved
- Approval questions — `ask_user_question` renders with `/approve`, `/reject` slash commands
- File attachments — send and receive images, video, audio, documents
- Reactions — send emoji reactions on messages
- Typing indicators — composing presence updates
- Credential requests — text fallback (WhatsApp has no modal support)

Not supported (WhatsApp linked-device limitation): edit messages, delete messages.

## Troubleshooting

### QR code or pairing code expired

Codes expire after ~60 seconds. The QR rotates automatically while the auth step
is running; if the step exited, clear the auth state and re-run it:

```bash
rm -rf store/auth/ && pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr
```

For pairing code, ensure digits only (no `+`), the phone has internet, and
WhatsApp is updated:

```bash
rm -rf store/auth/ && pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone <phone>
```

WhatsApp's pairing-code flow occasionally rejects valid codes with "Couldn't link
device." This is a server-side rejection unrelated to the code itself. If you hit
it more than once, switch to the QR method — it has a noticeably higher success
rate.

### "waiting for this message" on reactions

WhatsApp sessions corrupted from rapid restarts. Clear sessions, then restart the
service. Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
systemctl --user stop $(systemd_unit)
rm store/auth/session-*.json
systemctl --user start $(systemd_unit)
```

### Bot not responding

1. Auth exists: `test -f store/auth/creds.json`
2. Connected: `grep "Connected to WhatsApp" logs/nanoclaw.log | tail -1`
3. Channel wired: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.platform_id, mg.name FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id=mga.messaging_group_id WHERE mg.channel_type='whatsapp'"`
4. Service running: `systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"`

### "conflict" disconnection

Two instances connected with the same credentials. Ensure only one NanoClaw
process is running.
