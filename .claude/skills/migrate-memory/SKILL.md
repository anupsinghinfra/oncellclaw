---
name: migrate-memory
description: Migrate legacy NanoClaw group memory into the shared memory tree and provider-neutral standing instructions. Run after an update reports the shared-memory breaking change, or when a group still has .seed.md, CLAUDE.local.md, or an unindexed imported-agent-memory.md. Triggers on "migrate memory", "legacy memory", "the agent forgot everything after the switch".
---

# Migrate legacy memory

Every provider now uses the same `groups/<folder>/memory/` tree. Provider
switches carry memory automatically. This operator-run workflow moves legacy
files into that shared layout; normal host and container startup never imports
them.

The migration is deliberately content-blind. Do not open legacy files on the
host. Move regular files, quarantine symlinks without following them, then let
the group agent distill standing behavior and durable facts inside its
container.

## 1. Inventory and maintenance window

1. Run `ncl groups list` and identify every affected group folder.
2. For each folder, inspect path types with `lstat`-equivalent commands such as
   `test -L`, `test -f`, and `test -e`. Check:
   - `.seed.md`
   - `CLAUDE.local.md`
   - `memory/memories/imported-agent-memory.md`
   - `instructions.prepend.md`
   - `memory/index.md`
3. Show the operator the affected groups and collision/symlink status. Ask for
   approval before moving anything.
4. Ask the operator not to message these groups during the migration. Run
   `ncl groups restart --id <group-id>` for each affected group. Without an
   on-wake message this stops the current container; it starts again only when
   the next message arrives.

Process one group completely before starting the next. No runtime lock or
migration code is needed because the group is quiesced for this short window.

## 2. Prepare the shared tree

For each approved group:

1. Create `memory/system/`, `memory/memories/`, `memory/data/`, and
   `memory/.migration-quarantine/` if absent.
2. If `memory/index.md` or `memory/system/definition.md` is absent, copy its
   matching template from `container/agent-runner/src/memory-templates/`.
3. If either destination is a symlink or non-regular file, do not read or
   replace it. Report the path and stop this group for operator review.

Never overwrite an existing path.

## 3. Move legacy files

Use same-filesystem renames so each move is atomic.

### `.seed.md`

- Symlink: rename the symlink itself into
  `memory/.migration-quarantine/seed.md` (add a numeric suffix on collision).
- Regular file and `instructions.prepend.md` absent: rename `.seed.md` to
  `instructions.prepend.md`.
- `instructions.prepend.md` already exists, including a symlink: leave both
  paths untouched and ask the operator which standing instructions to keep.
- Any other `.seed.md` path type: leave it untouched and stop this group for
  operator review.

### `CLAUDE.local.md`

- Symlink: rename the symlink itself into
  `memory/.migration-quarantine/CLAUDE.local.md` (add a numeric suffix on
  collision).
- Regular file: rename it to
  `memory/memories/imported-claude-local.md`. If that path exists, use
  `imported-claude-local-2.md`, then `-3`, and so on. Do not skip or overwrite
  an existing suffix.
- Add a Map entry in `memory/index.md` for the renamed regular file:
  `- [Imported Claude local memory](memories/<filename>) - legacy memory awaiting in-container distillation.`
- Any other `CLAUDE.local.md` path type: leave it untouched and stop this group
  for operator review.

### `memory/memories/imported-agent-memory.md`

Leave the file in place. If it is regular and has no Map entry, add:

`- [Imported agent memory](memories/imported-agent-memory.md) - legacy creation instructions and memory awaiting in-container distillation.`

If it is a symlink, quarantine the symlink and remove only its exact stale Map
link if present. For any other path type, stop this group for operator review.

Before editing `memory/index.md`, confirm with `lstat` that it is a regular file
and not a symlink. Add `## Map` if an older index lacks that section, then add
links there, never under `## Core Memory`. Do not add duplicate links on a
rerun.

## 4. Distill inside the container

Restart the group with an on-wake task:

```bash
ncl groups restart --id <group-id> --message "Review every legacy import linked from memory/index.md. Move standing role, persona, and behavioral instructions into instructions.prepend.md without overwriting unrelated content. Move durable facts into Core Memory only when relevant in nearly every conversation; put other facts in focused linked memory files. Update the Map, then report what you changed."
```

The group agent performs this content-aware step inside its own workspace. Keep
the imported files until the operator approves the distillation; then the agent
may archive them under `memory/memories/` or remove their Map entries.

## 5. Verify and rollback

Verify for every group:

- no automatic migration occurred during an ordinary restart
- `memory/index.md` and `memory/system/definition.md` exist
- Core Memory contains facts, not an initial-instructions prompt
- standing behavior is in `instructions.prepend.md`
- imported files are linked under Map until distilled
- a test message can recall a migrated fact

Rollback before distillation is a rename in reverse: stop the group, move
`imported-claude-local*.md` back to `CLAUDE.local.md` or
`instructions.prepend.md` back to `.seed.md`, and remove only the Map line added
for that file. Never overwrite a path during rollback.
