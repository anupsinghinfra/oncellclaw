---
name: migrate-memory
description: Migrate legacy NanoClaw and Claude-native memory into the shared memory tree and provider-neutral standing instructions. Run after an update reports the shared-memory breaking change, or when a group still has .seed.md, legacy CLAUDE.md/CLAUDE.local.md, Claude auto-memory, or an unindexed imported-agent-memory.md. Triggers on "migrate memory", "legacy memory", "the agent forgot everything after the switch".
---

# Migrate legacy memory

Every provider now uses the same `groups/<folder>/memory/` tree. Provider
switches carry memory automatically. This operator-run workflow moves legacy
files into that shared layout; normal host and container startup never imports
them.

The migration is deliberately content-blind. Do not read legacy contents on
the host. Move regular files, quarantine symlinks without following them, then
let the group agent classify and distill content inside its container.

## 1. Inventory and maintenance window

1. Run `ncl groups list` and identify every affected group folder.
2. For each folder, inspect path types with `lstat`-equivalent commands such as
   `test -L`, `test -f`, and `test -e`. Check:
   - `.seed.md`
   - `CLAUDE.md`
   - `CLAUDE.local.md`
   - `memory/memories/imported-agent-memory.md`
   - `instructions.prepend.md`
   - `memory/index.md`
   - `data/v2-sessions/<group-id>/.claude-shared/projects/*/memory/`
3. Show the operator the affected groups and collision/symlink status. Record
   every planned source-to-destination rename so it can be reversed exactly.
   Ask for approval before moving anything.
4. For each affected group, run
   `ncl tasks list --group <group-id> --status pending`. Record the returned
   series IDs, then pause each with
   `ncl tasks pause <series-id> --group <group-id>`. Do not resume tasks that
   were already paused before this workflow.
5. Ask the operator not to message these groups during the migration. Run
   `ncl groups restart --id <group-id>` for each affected group. Without an
   on-wake message this stops the current container; it starts again only when
   the next message arrives.

Process one group completely before starting the next. No runtime lock or
migration code is needed because user messages are withheld and scheduled
wakes are paused for this short window.

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

### Legacy `CLAUDE.md`

- If absent, continue.
- Symlink: rename the symlink itself into
  `memory/.migration-quarantine/CLAUDE.md` (add a numeric suffix on
  collision).
- Regular file: without opening it, rename it to
  `memory/memories/imported-claude-md.md`, using `-2`, `-3`, and so on without
  skipping or overwriting collisions. The group agent classifies it later.
- Add a Map entry for a renamed regular file:
  `- [Imported CLAUDE.md](memories/<filename>) - legacy memory or generated composition awaiting in-container classification.`
- Any other path type: leave it untouched and stop this group for operator
  review.

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

### Claude native auto-memory

For every
`data/v2-sessions/<group-id>/.claude-shared/projects/*/memory/` path:

- Symlink: rename the symlink itself into
  `memory/.migration-quarantine/claude-auto-memory` (add a numeric suffix on
  collision).
- Directory: rename the entire directory, without opening its files, to
  `memory/memories/imported-claude-auto-memory`. For additional project
  directories or collisions use `-2`, then `-3`, and so on.
- Add a Map entry for each renamed directory:
  `- [Imported Claude auto-memory](memories/<directory>/) - native Claude memory awaiting in-container distillation.`
- Any other path type: leave it untouched and stop this group for operator
  review.

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
ncl groups restart --id <group-id> --message "Review every legacy import linked from memory/index.md. First classify imported-claude-md*.md: if its first line starts with '<!-- Composed at spawn', it is generated boilerplate, so remove that import and its exact Map entry without treating it as memory. Distill other imports by moving standing role, persona, and behavioral instructions into instructions.prepend.md without overwriting unrelated content. Move durable facts into Core Memory only when relevant in nearly every conversation; put other facts in focused linked memory files. Update the Map, then report what you changed."
```

The group agent performs this content-aware step inside its own workspace. Keep
the imported files until the operator approves the distillation; then the agent
may archive them under `memory/memories/` or remove their Map entries. Generated
composition boilerplate is the exception: it contains no legacy memory and is
removed during classification.

## 5. Verify and rollback

Verify for every group:

- no automatic migration occurred during an ordinary restart
- `memory/index.md` and `memory/system/definition.md` exist
- Core Memory contains facts, not an initial-instructions prompt
- standing behavior is in `instructions.prepend.md`
- imported files are linked under Map until distilled
- a test message can recall a migrated fact
- every task series paused in step 1 is resumed with
  `ncl tasks resume <series-id> --group <group-id>`; task series that were
  already paused remain paused

Rollback before distillation is every recorded rename in reverse: stop the
group, restore each source path from its exact destination, and remove only the
Map lines added for those imports. Restore any task series paused by this
workflow even when the migration is rolled back. Never overwrite a path during
rollback.
