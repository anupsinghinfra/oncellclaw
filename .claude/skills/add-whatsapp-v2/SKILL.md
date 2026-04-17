---
name: add-whatsapp-v2
description: Add WhatsApp channel to NanoClaw v2 using native Baileys adapter. Direct connection — no Chat SDK bridge. Uses QR code or pairing code for authentication.
---

# Add WhatsApp Channel

Adds WhatsApp support to NanoClaw v2 using the native Baileys adapter (no Chat SDK bridge).

## Pre-flight

Check if `src/channels/whatsapp.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

### Install the adapter packages

```bash
pnpm install @whiskeysockets/baileys@^6.7.21 pino@^9.6.0 qrcode@^1.5.4 @types/qrcode@^1.5.6
```

### Enable the channel

If `src/channels/whatsapp.ts` is missing, fetch it from upstream:

```bash
git remote -v | grep -q upstream || git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream v2
git checkout upstream/v2 -- src/channels/whatsapp.ts
```

Uncomment or add the WhatsApp import in `src/channels/index.ts`:

```typescript
// whatsapp (native, no Chat SDK)
import './whatsapp.js';
```

### Build

```bash
pnpm run build
```

## Credentials

WhatsApp uses linked-device authentication — no API key, just a one-time pairing from your phone.

### Check current state

Check if WhatsApp is already authenticated. If `store/auth/creds.json` exists, skip to "Shared vs dedicated number".

```bash
test -f store/auth/creds.json && echo "WhatsApp auth exists" || echo "No WhatsApp auth"
```

### Detect environment

Check whether the environment is headless (no display server):

```bash
[[ -z "$DISPLAY" && -z "$WAYLAND_DISPLAY" && "$OSTYPE" != darwin* ]] && echo "IS_HEADLESS=true" || echo "IS_HEADLESS=false"
```

### Ask the user

Use `AskUserQuestion` to collect configuration. **Adapt auth options based on environment:**

If IS_HEADLESS=true AND not WSL → AskUserQuestion: How do you want to authenticate WhatsApp?
- **Pairing code** (Recommended) - Enter a numeric code on your phone (no camera needed, requires phone number)
- **QR code in terminal** - Displays QR code in the terminal (can be too small on some displays)

Otherwise (macOS, desktop Linux, or WSL) → AskUserQuestion: How do you want to authenticate WhatsApp?
- **QR code in browser** (Recommended) - Opens a browser window with a large, scannable QR code
- **Pairing code** - Enter a numeric code on your phone (no camera needed, requires phone number)
- **QR code in terminal** - Displays QR code in the terminal (can be too small on some displays)

If they chose pairing code:

AskUserQuestion: What is your phone number? (Digits only — country code followed by your 10-digit number, no + prefix, spaces, or dashes. Example: 14155551234 where 1 is the US country code and 4155551234 is the phone number.)

### Clean previous auth state (if re-authenticating)

```bash
rm -rf store/auth/
```

### Run WhatsApp authentication

For QR code in browser (recommended):

```bash
pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr-browser
```

(Bash timeout: 150000ms)

Tell the user:

> A browser window will open with a QR code.
>
> 1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
> 2. Scan the QR code in the browser
> 3. The page will show "Authenticated!" when done

For QR code in terminal:

```bash
pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr-terminal
```

(Bash timeout: 150000ms)

Tell the user:

> 1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
> 2. Scan the QR code displayed in the terminal

For pairing code:

Tell the user to have WhatsApp open on **Settings > Linked Devices > Link a Device**, ready to tap **"Link with phone number instead"** — the code expires in ~60 seconds and must be entered immediately.

Run the auth process in the background and poll `store/pairing-code.txt` for the code:

```bash
rm -f store/pairing-code.txt && pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone <their-phone-number> > /tmp/wa-auth.log 2>&1 &
```

Then immediately poll for the code (do NOT wait for the background command to finish):

```bash
for i in $(seq 1 20); do [ -f store/pairing-code.txt ] && cat store/pairing-code.txt && break; sleep 1; done
```

Display the code to the user the moment it appears. Tell them:

> **Enter this code now** — it expires in ~60 seconds.
>
> 1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
> 2. Tap **Link with phone number instead**
> 3. Enter the code immediately

After the user enters the code, poll for authentication to complete:

```bash
for i in $(seq 1 60); do grep -q 'STATUS: authenticated' /tmp/wa-auth.log 2>/dev/null && echo "authenticated" && break; grep -q 'STATUS: failed' /tmp/wa-auth.log 2>/dev/null && echo "failed" && break; sleep 2; done
```

**If failed:** logged_out → delete `store/auth/` and re-run. timeout → ask user, offer retry.

### Verify authentication succeeded

```bash
test -f store/auth/creds.json && echo "Authentication successful" || echo "Authentication failed"
```

### Shared vs dedicated number

AskUserQuestion: Is this a shared phone number (personal WhatsApp) or a dedicated number?
- **Shared number** — your personal WhatsApp (bot prefixes messages with its name)
- **Dedicated number** — a separate phone/SIM for the assistant

If dedicated, add to `.env`:

```bash
ASSISTANT_HAS_OWN_NUMBER=true
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `whatsapp`
- **terminology**: WhatsApp calls them "groups" and "chats." A "chat" is a 1:1 DM; a "group" has multiple members.
- **how-to-find-id**: DMs use `<phone>@s.whatsapp.net` (e.g. `14155551234@s.whatsapp.net`). Groups use `<id>@g.us`. To find your number: `node -e "const c=JSON.parse(require('fs').readFileSync('store/auth/creds.json','utf-8'));console.log(c.me?.id?.split(':')[0]+'@s.whatsapp.net')"`. Groups are auto-discovered — check `sqlite3 data/v2.db "SELECT platform_id, name FROM messaging_groups WHERE channel_type='whatsapp' AND is_group=1"`.
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

Not supported (WhatsApp linked device limitation): edit messages, delete messages.

## Troubleshooting

### QR code expired

QR codes expire after ~60 seconds. Re-run the auth command:

```bash
rm -rf store/auth/ && pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr-browser
```

### Pairing code not working

Codes expire in ~60 seconds. Delete auth and retry:

```bash
rm -rf store/auth/ && pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone <phone>
```

Ensure: digits only (no `+`), phone has internet, WhatsApp is updated.

If pairing code keeps failing, switch to QR-browser auth instead:

```bash
rm -rf store/auth/ && pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr-browser
```

### "waiting for this message" on reactions

Signal sessions corrupted from rapid restarts. Clear sessions:

```bash
systemctl --user stop nanoclaw
rm store/auth/session-*.json
systemctl --user start nanoclaw
```

### Bot not responding

1. Auth exists: `test -f store/auth/creds.json`
2. Connected: `grep "Connected to WhatsApp" logs/nanoclaw.log | tail -1`
3. Channel wired: `sqlite3 data/v2.db "SELECT mg.platform_id, mg.name FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id=mga.messaging_group_id WHERE mg.channel_type='whatsapp'"`
4. Service running: `systemctl --user status nanoclaw`

### "conflict" disconnection

Two instances connected with same credentials. Ensure only one NanoClaw process is running.
