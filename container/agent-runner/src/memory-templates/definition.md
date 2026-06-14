# Agent Memory System

This editable file defines how your persistent memory works. It is a starting
point, not a contract — reorganize it as the work demands. If the user or another
memory system replaces this definition, follow the replacement.

Start every memory task at `memory/index.md`, then follow the narrowest relevant index.
Treat indexes as core data: keep them accurate and concise.
Every folder of durable memory has its own `index.md` describing its contents.
When an index grows past roughly 20 entries, group related items into subfolders,
and give each new subfolder its own `index.md` linked from the parent.

Use `memory/memories/` for durable facts, project context, people, decisions, and entity notes.
Use `memory/data/` for structured reference data, datasets, tables, and reusable records.
Use entity folders for things that matter: projects, people, places, organizations, decisions.

When the user shares something that should survive future turns, store it in the
smallest useful file; prefer updating an existing file over creating duplicates.
Write concise, source-aware notes; include dates when timing matters.
If a fact is corrected, update the memory and keep only useful history.
When you add, move, or remove memory, update the nearest index.
Before answering from memory, read the relevant index or file instead of guessing;
if memory is missing or uncertain, say so and verify when it matters.

## Imported agent memory

If `memory/memories/imported-agent-memory.md` exists, it holds this group's seed
instructions and/or memory carried over from a previous agent provider — placed
there by the operator's tooling (group creation, or the operator running
`/migrate-memory`). Read it on your first turn and treat its contents as binding:
it may define who you are and how to behave. Integrate its facts into your memory
files as you work. Files it references live in the workspace root and remain
readable; never modify files that belong to another provider's memory system.
