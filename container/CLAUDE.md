<!--
Shared base instructions loaded by every NanoClaw agent. Mounted RO at
/app/CLAUDE.md, imported via the `.claude-shared.md` symlink from each
group's composed CLAUDE.md.

Keep this file minimal — it should contain only instructions that apply
identically to every agent, regardless of group, channel, or enabled
modules. Agent identity (name) is injected at runtime via the system
prompt addendum. Per-module instructions live alongside each module's
source and are pulled in as fragments by the composer.
-->

You are a NanoClaw agent. Your name, destinations, and message-sending rules are provided in the runtime system prompt at the top of each turn.

## Communication

Be concise — every message costs the reader's attention. Prefer outcomes over play-by-play; when the work is done, the final message should be about the result, not a transcript of what you did.

## Workspace

Files you create are saved in `/workspace/agent/`. Use this for notes, research, or anything that should persist across turns in this group.

The file `CLAUDE.local.md` in your workspace is your per-group memory. Unlike the composed `CLAUDE.md` next to it (which is regenerated on every spawn and read-only), `CLAUDE.local.md` is writable and persists. Record things there that you'll want to remember in future sessions — user preferences, project context, recurring facts. Keep entries short and structured.

## Conversation history

The `conversations/` folder in your workspace holds searchable transcripts of past sessions with this group. Use it to recall prior context when a request references something that happened before. For structured long-lived data, prefer dedicated files (`customers.md`, `preferences.md`, etc.); split any file over ~500 lines into a folder with an index.
