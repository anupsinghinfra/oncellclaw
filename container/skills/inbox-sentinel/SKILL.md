---
name: inbox-sentinel
description: >-
  Always-on email chief of staff: watch Gmail/Outlook through the OnCell
  integrations proxy on a recurring schedule, triage actionable mail into a
  durable todo.md, remind only when something crosses an action threshold,
  and act on email or calendar when the user asks — with approval or a
  standing grant. Use when the user wants their inbox watched or managed,
  a todo list kept from email, or asks "what's on my plate" / "anything
  urgent".
metadata:
  author: oncell
  version: '1.0'
---

# Inbox Sentinel — the always-on email chief of staff

Five behaviors: **watch** on a schedule, **triage** into a durable todo
list, **remind** only past thresholds, **act** on instruction with
approval, and answer **on demand** from the list. The morning-briefing
skill is the thin daily-digest preset of this one — a single scheduled run
each morning; Inbox Sentinel is the continuous version. All external calls
go through the oncell-integrations proxy — reference that skill for the
credential rules (never OAuth, never ask for keys, connect happens on the
OnCell dashboard); do not re-derive them here.

## 1. Watch (recurring scheduled task)

Create the watcher once, in the chat session where the user asks (ask how
often they want checks; default every 20 minutes — the durable-wake bridge
fires it 24/7 on hosted claws, laptop closed or not):

```bash
ncl tasks create \
  --name "inbox sentinel" \
  --recurrence "*/20 * * * *" \
  --prompt "Run the inbox-sentinel skill check cycle."
```

Each cycle, list providers once, then pull new mail from every connected
mail provider:

```bash
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations"

# Gmail — unread ids, then per-id metadata
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages?q=is:unread%20newer_than:1d&maxResults=25"
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages/{id}?format=metadata"

# Outlook — unread via Microsoft Graph (when the provider is connected)
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/outlook/proxy/me/messages?\$filter=isRead%20eq%20false&\$top=25"
```

Degrade per provider, never per run: on `{"error":"not_connected"}` skip
that provider and — **once, not every cycle** (track it in the state
file) — tell the user:

> Connect {Provider} on your OnCell dashboard → Integrations
> (https://oncell.ai/dashboard/integrations), then tell me and I'll retry.

A transport error skips that provider for this cycle with no user-facing
noise. One connected provider is enough for the sentinel to be useful.

## 2. Triage into todo.md

`todo.md` in the group workspace is the **single durable todo list** —
checkbox markdown, three fixed sections:

```markdown
# Todo

## Inbox-derived
- [ ] Reply to Priya — contract redlines, she asked for an answer today · urgent (gmail:1920a3f7b) [suggest: confirm the Thursday timeline]
- [ ] Review CI-failure notification thread · this-week (gmail:1920a3f01)

## User-added
- [ ] Book flights for the offsite

## Waiting-on
- [ ] Sam to send the deck — asked Aug 2 (gmail:191fe2c44)
```

Every actionable email becomes one Inbox-derived item: action verb +
who/what, an urgency tag (`urgent` / `today` / `this-week`), the source
ref `(gmail:<message-id>)` or `(outlook:<message-id>)`, and optionally a
`[suggest: …]` action. **Non-actionable mail — newsletters, receipts,
automated FYI notifications — never surfaces**: no todo, no reminder, no
mention. Noise is the failure mode this skill exists to kill.

Dedupe by message id in a small state file next to the list —
`inbox-sentinel.state.json`:

```json
{
  "seenMessageIds": ["gmail:1920a3f7b", "outlook:AAMkAD…"],
  "lastCheckAt": "2026-08-04T09:20:00Z",
  "connectNudged": { "outlook": true }
}
```

A message id already in `seenMessageIds` is never re-triaged. Keep the
list bounded (drop ids older than the newest ~500).

## 3. Remind (thresholds, batching, quiet hours)

Message the user unprompted **only** when something crosses an action
threshold:

- a new item triaged `urgent`;
- an existing item aging past its remind-at (e.g. "due today" still
  unchecked in the afternoon);
- a calendar conflict discovered while triaging (check via the
  google-calendar proxy when an email implies a time commitment):

```bash
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/google-calendar/proxy/calendar/v3/calendars/primary/events?timeMin=<start>&timeMax=<end>&singleEvents=true&orderBy=startTime"
```

Batch every crossing into **one message per check cycle — never more than
one unprompted message per cycle**, delivered with `send_message` to the
user's active channel (task sessions deliver only through `send_message`).
Respect quiet hours: ask the user once what they are and store the answer
in memory; during quiet hours hold reminders and fold them into the first
cycle after they end.

## 4. Act on instruction (approval-gated)

When the user replies — "reply to Priya saying…", "archive the
newsletter", "schedule 30min with Sam Thursday" — perform it through the
proxy:

```bash
# Gmail — send (raw = base64url-encoded RFC 822 message)
curl -s -X POST -H "Authorization: Bearer $ONCELL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"raw":"<base64url RFC822>"}' \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages/send"

# Gmail — archive / mark read
curl -s -X POST -H "Authorization: Bearer $ONCELL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"removeLabelIds":["INBOX","UNREAD"]}' \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages/{id}/modify"

# Outlook — send
curl -s -X POST -H "Authorization: Bearer $ONCELL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"message":{"subject":"…","body":{"contentType":"Text","content":"…"},"toRecipients":[{"emailAddress":{"address":"…"}}]}}' \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/outlook/proxy/me/sendMail"

# Google Calendar — create an event
curl -s -X POST -H "Authorization: Bearer $ONCELL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"summary":"Sam / 1:1","start":{"dateTime":"…"},"end":{"dateTime":"…"}}' \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/google-calendar/proxy/calendar/v3/calendars/primary/events"
```

**Hard rule — never act without approval or a standing grant.** Any
outbound send or calendar write requires either (a) the user confirming
the exact draft / event details in this conversation (show them what will
go out, in the spirit of the approvals module: the gate sits in front of
the action, not in your good intentions), or (b) a **standing grant** the
user gave earlier — "you can always archive newsletters", "you may accept
invites that don't conflict" — recorded verbatim, with its date, in
memory, and applied only to exactly that action class. Reads never need
approval. After every action, update `todo.md` (check the item off, or
move it to Waiting-on with the date).

## 5. On demand

"what's on my plate", "todo list", "anything urgent" → render from
`todo.md` — do **not** re-fetch mail to answer. "add X to my list" /
"done with X" edits the User-added section (or checks the item off)
immediately.

## Hard rules

- Never send email or write to a calendar without explicit approval in the
  conversation or a recorded standing grant for that exact action class.
- Never surface non-actionable mail — no todo, no reminder, no mention.
- At most one unprompted message per check cycle; batch everything.
- Provider missing → the connect copy above, once; keep working with
  whatever is connected.
- Credential rules are oncell-integrations' rules: never ask the user for
  API keys, tokens, or passwords, and never route them through browser
  OAuth.
