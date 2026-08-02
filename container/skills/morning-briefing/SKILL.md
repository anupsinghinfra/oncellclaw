---
name: morning-briefing
description: >-
  Set up and run a daily morning briefing as a scheduled task: unread email
  + today's calendar (via the oncell-integrations proxy) + anything the
  user flagged yesterday, delivered to their preferred channel. Use when
  the user asks for a morning briefing, a daily digest, or any
  "summarize my day every morning" routine.
metadata:
  author: oncell
  version: '1.0'
---

# Morning Briefing — a scheduled-task template

This is the thin **daily-digest preset** of the `inbox-sentinel` skill —
one run each morning. If the user wants their inbox watched continuously
(triage, todo list, threshold reminders), set up inbox-sentinel instead;
the two share the same proxy endpoints and degradation rules.

Two halves, two session kinds:

- **Setup** happens in the chat session where the user asked for it: pick a
  time and a destination, create the task.
- **The run** happens in the task's own system session every morning: gather
  the sections, compose one message, deliver it with `send_message`.

## Setup (chat session)

1. Ask at most two questions: **what time** (default 8:00) and **which
   channel** (default: the channel they asked from; name a destination you
   can actually send to).
2. Check what the briefing will contain — one call, then tell them:

   ```bash
   curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
     "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations"
   # → [{"provider":"gmail","connected":true},{"provider":"google-calendar","connected":false},…]
   ```

   For each of `gmail` and `google-calendar` that is not connected, say:

   > Connect {Provider} on your OnCell dashboard → Integrations
   > (https://oncell.ai/dashboard/integrations), then tell me and I'll retry.

   Do **not** block setup on it — the briefing includes whatever is
   connected on each run, so a provider connected later just starts
   appearing.
3. Create the task (cron runs in the install timezone; `--group` is filled
   in automatically inside your container):

   ```bash
   ncl tasks create \
     --name "morning briefing" \
     --recurrence "0 8 * * *" \
     --prompt "Run the morning-briefing skill: compose today's briefing and send it to <destination>."
   ```

4. Confirm the time, the destination, and which sections are live today.

## The run (task session)

Gather the three sections. **Each section degrades independently — a dead
source never fails the whole run.**

### 1. Unread email (gmail)

```bash
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages?q=is:unread%20newer_than:1d&maxResults=15"
```

Fetch sender/subject for the ids it returns
(`…/proxy/gmail/v1/users/me/messages/{id}?format=metadata`). Report the
unread count and call out only the few that actually look important —
people over newsletters, questions over notifications.

### 2. Today's calendar (google-calendar)

Compute today's local start and tomorrow's local start in the install
timezone (`date` is your friend), then:

```bash
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/google-calendar/proxy/calendar/v3/calendars/primary/events?timeMin=<today-local-ISO>&timeMax=<tomorrow-local-ISO>&singleEvents=true&orderBy=startTime"
```

List time + title in order; call out the first meeting of the day and any
overlaps.

### 3. Flagged yesterday (memory)

Check your memory (`memory/index.md` and recent notes) for anything the
user flagged, deferred, or left unfinished yesterday — "remind me
tomorrow", follow-ups they promised, threads that ended in "I'll deal with
this later". Include only items that are genuinely theirs to act on; if
there are none, omit the section silently.

### 4. Compose and deliver

One message, delivered with the `send_message` tool to the destination
named in the task prompt — task sessions deliver **only** through
`send_message`; final text just lands in the run log. Keep it scannable:

```
Good morning — Tuesday, Aug 4

📧 Email: 12 unread, 2 worth a look
  · Dana — "contract redlines" (asked for a reply today)
  · GitHub — CI failing on main since last night

📅 Calendar: 3 events, first at 9:30
  · 9:30 standup · 12:00 lunch w/ Sam · 15:00 design review (overlaps 15:00 1:1 — pick one)

📌 Flagged yesterday
  · You wanted to follow up with the vendor about pricing
```

If every section came back empty, still send a one-liner ("Quiet morning —
no unread mail, no events, nothing flagged.") so the user knows the
briefing ran.

## Degrading gracefully

- **Provider not connected** (`{"error":"not_connected"}`): skip the
  section and append one line — "Connect {Provider} on your OnCell
  dashboard → Integrations (https://oncell.ai/dashboard/integrations) to
  add it to this briefing." Never treat it as a failure and never retry it
  within the run.
- **Proxy error or timeout**: skip the section with a one-line "couldn't
  reach {Provider} this morning" note. One attempt per source per run — do
  not retry-hammer, and never let one source fail the whole briefing.
- **`ONCELL_API_KEY` missing**: integrations are not available on this
  install — deliver a memory-only briefing (section 3) and say plainly,
  once, that email/calendar aren't available here.
- All oncell-integrations rules apply: never ask the user for API keys,
  tokens, or passwords, and never route them through browser OAuth — the
  dashboard owns the connect flow.
