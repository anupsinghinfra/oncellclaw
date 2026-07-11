# Agent Memory System

This file defines how your persistent memory works, and it is yours: a starting
point, not a contract. Only two paths are fixed, because the system loads them:
`memory/index.md` and this file at `memory/system/definition.md`. Everything
else - the folders, the format, even these rules - is yours to reshape whenever
a different shape would remember or retrieve better. If the user or another
memory system replaces this definition, follow the replacement.

`memory/index.md` and this definition are loaded whenever a context window is
created: at startup, after clear, and after compaction. They are not reinjected
on resume because the existing conversation already contains them. Everything
in these two files taxes every conversation, so keep both lean: headlines and
pointers here, detail in linked files. Core Memory in the index holds only
durable facts relevant in nearly every conversation; standing behavior, role,
and persona belong in `/workspace/agent/instructions.prepend.md`.

## What to remember

Remember the approach, not the instance. When something seems worth keeping,
ask yourself what it is an instance of. If the user disliked the wording of one
post, the durable fact is probably a style preference, not that post; when it
matters and you are unsure, ask the user which it is. Store the specific only
when the fact itself is specific ("the user's name is Bob").

Think in entities. People, projects, teams, places, decisions: things that
recur deserve their own note or folder, with relationships recorded ("Dana
leads the Atlas project"). Choose whatever shape retrieves best: a note, a
table, a folder. The idea is fixed; the format is your call.

## Where it goes

Start every memory task at `memory/index.md`, then follow the narrowest
relevant index. Indexes are core data: every folder of durable memory has an
`index.md` describing its contents. Past roughly 20 entries, group related
items into subfolders, each with its own `index.md` linked from the parent.

The starting layout, not a rule - reshape it as your memory grows:

- `memory/memories/` - durable facts, project context, people, decisions, entity notes
- `memory/data/` - structured reference data, datasets, tables, reusable records

Write to the smallest useful file for the entity the fact is about. Update
that entity's existing file rather than creating duplicates, and don't default
to whichever file is already open or most recently discussed. Be concise and
source-aware; include dates when timing matters.

## Keep it true

When a fact is corrected, update the memory and keep only useful history. Prune
what stopped mattering. Whenever you add, move, or remove memory, update the
nearest index. Before answering from memory, read the relevant index or file
instead of guessing; if memory is missing or uncertain, say so and verify when
it matters.
