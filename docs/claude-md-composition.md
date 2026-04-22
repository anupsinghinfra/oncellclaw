# CLAUDE.md Composition

Compose agent instructions from a shared base, skill/tool fragments, and per-group memory — replacing the current per-group CLAUDE.md with a host-regenerated entry point.

## Problem

Today each agent group has a single RW `groups/<folder>/CLAUDE.md`, written once at init and never updated. Consequences:

- Upstream improvements to shared agent guidance don't propagate to existing groups
- No way to ship tool-specific guidance with the tool itself (e.g., an agent-browser usage fragment)
- Human-authored identity and agent-accumulated memory live in the same file with no separation
- The `.claude-global.md` symlink + `groups/global/CLAUDE.md` pattern handled the shared base but not per-module fragments

## Design

**Principle: RW = per-group memory, RO = shared content.** Same rule that governs the shared-source refactor, applied to agent instructions.

### Three tiers

| Tier | File | Location | Mount | Editor | Change rate |
|---|---|---|---|---|---|
| **Shared base** | `CLAUDE.md` | `container/CLAUDE.md` | RO at `/app/CLAUDE.md` | Owner (via git) | Rare |
| **Module fragments** | `instructions.md` | Inside each module | RO via shared skills mount, or inline in `container.json` | Module author | Ships with module |
| **Per-group memory** | `CLAUDE.local.md` | `groups/<folder>/` | RW at `/workspace/agent/` | Agent + owner | Continuous |
| **Composed entry** | `CLAUDE.md` | `groups/<folder>/` | RW but host-regenerated | **Host, not human** | Every spawn |

### Composition

At every spawn, the host regenerates `groups/<folder>/CLAUDE.md` as an import-only file:

```markdown
<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->
@./.claude-shared.md
@./.claude-fragments/welcome.md
@./.claude-fragments/agent-browser.md
@./.claude-fragments/<enabled-skill-with-fragment>.md
@./.claude-fragments/mcp-<server-name>.md
```

Symlinks are created alongside, following the `.claude-global.md` pattern (dangling on host, valid in container via the RO mount):

- `groups/<folder>/.claude-shared.md` → `/app/CLAUDE.md`
- `groups/<folder>/.claude-fragments/<name>.md` → `/app/skills/<name>/instructions.md` (for each enabled skill that ships a fragment)

Claude Code auto-loads `CLAUDE.local.md` from cwd without an import line — native behavior. Agent memory works natively; composition only wraps around it.

### Module fragment contract

**Skills.** A skill optionally ships an `instructions.md` at the top of its directory:

```
container/skills/welcome/
  SKILL.md          — description + when-to-use (existing)
  instructions.md   — always-in-context guidance (optional, new)
```

When the skill is enabled for a group, the host imports `instructions.md` into the composed CLAUDE.md. `SKILL.md` semantics are unchanged — Claude Code still uses it for skill discovery and on-demand invocation. Most skills won't need an `instructions.md` (SKILL.md is sufficient for on-demand skills); it's only for guidance that should be in context at all times.

**MCP servers.** A `container.json` MCP server entry can contribute a fragment inline:

```jsonc
{
  "mcpServers": {
    "my-db": {
      "command": "...",
      "instructions": "Read-only access to the production DB. Never run UPDATE/DELETE without admin approval."
    }
  }
}
```

Host writes the inline content to `.claude-fragments/mcp-<server-name>.md` at spawn and imports it.

**Global CLIs baked into the image** (agent-browser, vercel, claude-code) have always-present guidance; it belongs in `container/CLAUDE.md`, not as a conditional fragment. Don't try to make universally-present tools dynamic.

### Identity vs memory

All per-group content — human-authored identity ("you are the research agent, be terse") and agent-accumulated memory (inventories, user preferences, learned patterns) — lives in a single `CLAUDE.local.md`. Both humans and agents can edit it.

If the distinction becomes operationally important later (agents confused about what they were told vs. what they learned), split into `identity.md` (human-authored, imported into composed CLAUDE.md) + `CLAUDE.local.md` (agent memory only). Starting with one file.

## Changes

### `container/CLAUDE.md` (new)

Write the shared base: general NanoClaw context, how to engage with users, output conventions, anything that should apply to every agent across every group. Seed from current `groups/global/CLAUDE.md`.

### `container/skills/<name>/instructions.md` (optional, per skill)

Add for any skill that warrants always-in-context guidance. Optional.

### `container.json` schema

Add optional `instructions` field (string) to each MCP server entry.

### `container-runner.ts` spawn-time sync

Extend the skill-symlink sync function (added in the shared-source refactor) to also compose CLAUDE.md. On every spawn:

1. Sync `.claude-shared/skills/<name>` symlinks from `container.json` skill selection.
2. Sync `.claude-shared.md` symlink → `/app/CLAUDE.md`.
3. For each enabled skill with an `instructions.md`, create `.claude-fragments/<name>.md` symlink → `/app/skills/<name>/instructions.md`.
4. For each `container.json` MCP server with an `instructions` field, write the inline content to `.claude-fragments/mcp-<server-name>.md`.
5. Write `groups/<folder>/CLAUDE.md` atomically (temp + rename) with import lines in a deterministic order: shared base → skill fragments (alphabetical) → MCP fragments (alphabetical).
6. Remove stale symlinks and fragment files for modules no longer enabled.

### `group-init.ts`

- Stop writing an initial `groups/<folder>/CLAUDE.md` at group creation — host regenerates at first spawn.
- Stop creating the `.claude-global.md` symlink — replaced by `.claude-shared.md` in the composition step.
- Optionally create an empty `groups/<folder>/CLAUDE.local.md` at init as a clear affordance for humans and agents.

### `groups/global/`

Eliminate. The shared base moves to `container/CLAUDE.md`. Any deployment-specific overrides live in the owner's customized `container/CLAUDE.md` (same pattern as any other codebase customization).

## Migration

Breaking change, one-time cutover:

- For every group, rename `groups/<folder>/CLAUDE.md` → `groups/<folder>/CLAUDE.local.md`. Preserves all existing per-group content as memory.
- Move content from `groups/global/CLAUDE.md` (beyond the default stub) into `container/CLAUDE.md`. Delete `groups/global/`.
- Delete stale `.claude-global.md` symlinks in each group dir — the spawn pass creates `.claude-shared.md` instead.
- First spawn after cutover regenerates `CLAUDE.md` with proper imports.

## Interaction with shared-source refactor

This refactor depends on the shared skills mount (`/app/skills/` RO) from the shared-source refactor landing first. It extends the spawn-time sync from "just skill symlinks" to "skill symlinks + CLAUDE.md composition" — both passes share the same helper.

After this refactor, the "Personality / instructions" row in the shared-source per-group customization table splits:

| Resource | Location | Mechanism |
|----------|----------|-----------|
| Agent memory | `groups/<folder>/CLAUDE.local.md` | RW at `/workspace/agent/`, auto-loaded by Claude Code |
| Composed entry | `groups/<folder>/CLAUDE.md` | Host-regenerated at every spawn |

## What triggers what

| Change | Action | Scope |
|--------|--------|-------|
| Edit `container/CLAUDE.md` | Kill running containers (next spawn recomposes) | All groups |
| Add/edit a skill's `instructions.md` | Kill running containers | All groups with the skill enabled |
| Enable/disable a skill in `container.json` | Kill that group's containers | One group |
| Add MCP server with `instructions` field | Kill that group's containers | One group |
| Edit `CLAUDE.local.md` | Nothing — live via RW mount; Claude Code re-reads at next prompt | One group |
| Add a new agent group | Spawn writes `CLAUDE.md` fresh from the composition pass | One group |
