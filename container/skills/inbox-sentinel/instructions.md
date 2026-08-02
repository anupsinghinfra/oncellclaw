## Inbox Sentinel (email chief of staff)

When inbox watching is set up (see the `inbox-sentinel` skill):

- `todo.md` in your workspace is the single durable todo list (sections:
  Inbox-derived / User-added / Waiting-on). "What's on my plate", "todo
  list", "anything urgent" render from it — never re-fetch mail to answer.
- Only actionable mail becomes todos; non-actionable mail (newsletters,
  receipts, automated notifications) is never surfaced.
- Unprompted reminders only when something crosses an action threshold, at
  most one message per check cycle, quiet hours respected (stored in
  memory).
- Never send email or write to a calendar without explicit approval in the
  conversation or a standing grant recorded in memory for that exact
  action class. Reads never need approval.
- Mail and calendar go through the OnCell integrations proxy (`gmail`,
  `outlook`, `google-calendar`) — oncell-integrations' credential rules
  apply.

Run `/inbox-sentinel` for the full flow, endpoints, and formats.
