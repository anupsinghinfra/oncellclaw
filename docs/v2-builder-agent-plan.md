# Builder Agent: Self-Modification via Delegated Dev Agent

Plan for the self-modification flow tracked under "Self-modification via builder-agent delegation" in `v2-checklist.md`. Lets a user request code changes from chat, have a dev agent produce them in an isolated worktree copy, and land them through a host-gated approval + deadman-restart dance. Goal is to replace terminal-based customization entirely for the common case.

## Goal

Enable full customization of a NanoClaw install from chat, without returning to the terminal, while guaranteeing:

1. **No cross-group data leakage** — dev agent cannot see another group's session DB, memory, or credentials.
2. **Owner/admin approval on every live change** — nothing runs without an explicit human gate.
3. **Automatic rollback** — if the new version doesn't handshake back within its window, it reverts without user action.
4. **No self-modification footgun** — dev agent edits a copy, never the code it's currently running on.
5. **Per-group isolation preserved** — one group's customizations stay local to that group unless the user explicitly promotes them.

## Per-Group Copy Architecture (existing)

This plan builds on a mechanism that already exists in v2. It's important context for the classification model below.

On first spawn of an agent group, `src/group-init.ts::initGroupFilesystem()` creates **private per-group copies** of:

| Repo path (template) | Private per-group path | Container mount |
|----------------------|------------------------|-----------------|
| `container/agent-runner/src/` | `data/v2-sessions/<group-id>/agent-runner-src/` | `/app/src` (rw) |
| `container/skills/` | `data/v2-sessions/<group-id>/.claude-shared/skills/` | `/home/node/.claude/skills` (rw) |
| `groups/<folder>/CLAUDE.md` | (same path, owned by group) | `/workspace/agent` (rw) |

After init, the host **never overwrites** the private copies on upstream updates — the group owns them. Changes to the repo's `container/agent-runner/src/` or `container/skills/` only affect **new** groups created after the change. Existing groups keep running their private copies forever unless explicitly refreshed.

This means edits to runner or skills code can land safely in one group without touching any other group. The per-group copy mechanism is the foundation for the whole "dev agent edits runner code" story — without it, runner edits would be host-level and globally disruptive.

**Gitignore adjustment (new):** today `data/` is gitignored wholesale. For this feature, we carve out exceptions so each group's private code is tracked in the main repo:

```gitignore
data/**
!data/v2-sessions/
!data/v2-sessions/*/
!data/v2-sessions/*/agent-runner-src/
!data/v2-sessions/*/agent-runner-src/**
!data/v2-sessions/*/.claude-shared/
!data/v2-sessions/*/.claude-shared/skills/
!data/v2-sessions/*/.claude-shared/skills/**
```

(`groups/<folder>/CLAUDE.md` is already in the repo.) Every swap commits the updated per-group files to main alongside the swap metadata, giving us full per-group code history in one repo — `git log data/v2-sessions/<id>/agent-runner-src/` shows everything a group has ever run. **Rollback uses git:** `git checkout <pre-swap-sha> -- <affected-paths>` plus a forward-only revert commit for auditability. One mechanism for file state; no separate blob-storage table needed.

## Mental Model

The dev agent is a **clone of the originating agent**: same container image, same mounts, same OneCLI agent identity (so same credential scope, same LLM routing, same privilege). It is spawned by the originating agent's group via the standard `create_agent` path and inherits privilege automatically because it runs under the same OneCLI agent.

Beyond those shared mounts, the dev agent gets one extra mount: a **git worktree copy of the whole repo**, writable, containing everything except `data/`, `store/`, and real `.env`. The worktree is constructed by:

1. `git worktree add .worktrees/dev-<id> HEAD` — gets all repo-tracked files.
2. Overlay: copy `data/v2-sessions/<originating-id>/agent-runner-src/*` → `<worktree>/container/agent-runner/src/` (overwriting the template with the originating group's current customized runner).
3. Overlay: copy `data/v2-sessions/<originating-id>/.claude-shared/skills/*` → `<worktree>/container/skills/` (same reason).
4. Shadow-mount a dummy `.env`; exclude `data/` and `store/` entirely.

Now the dev agent's worktree reflects exactly what the originating group is currently running — not a pristine template. Edits go to this copy. On swap, the host maps worktree paths back to the right destinations (per-group private dir for runner/skills, repo paths for host code).

Because the dev agent's own runtime is the live code, not the worktree, **self-modification is structurally impossible**: the dev agent cannot change the code it's currently running on.

## Actors

| Actor | Role |
|-------|------|
| **Originating agent** (agent-A) | User-facing agent the user is chatting with. Decides a change is needed, spawns the dev agent, brokers the pre-swap handshake with the user. |
| **Dev agent** | Clone of agent-A created by agent-A's group. Inherits agent-A's OneCLI scope and privilege. No web access. Works in a dedicated worktree overlaid with the originating group's current state. |
| **Host** | Creates the worktree (with overlays), mounts it, classifies the diff, routes approval, runs the swap dance, runs the deadman timer, handles rollback and promote-to-template. |
| **Approver** | Group admin (group-level diffs) or owner (host-level diffs, typed confirmation). |

## Flow

### 1. User requests a change

User → agent-A in chat: "add feature X" / "fix this bug" / "rename my welcome message."

Agent-A determines the request needs code edits, calls a new MCP tool `request_dev_changes(summary)`.

### 2. Host spawns dev agent + worktree

- **If a previous dev agent exists for this originating group, tear it down now.** The originating agent may keep talking to a prior dev agent between requests (e.g. "hey, can you also tweak X" follow-up chat), but the moment a **new** `request_dev_changes` call comes in, the prior dev agent group is wound down and its worktree cleaned up. One live dev agent at a time per originating group.
- Host creates a **fresh** dev agent group per request. Originating agent can supply a name in `request_dev_changes(summary, dev_agent_name?)` so the dev agent has a stable identity for conversation (e.g. "dev-refactor-welcome"). If no name given, auto-generated.
- Dev agent created through the existing `create_agent` path, under agent-A's OneCLI agent identity, so it inherits credential scope and privilege. **Upstream dependency:** OneCLI parent-child privilege inheritance (`onecli agents create --inherit-from <parent>`) would make this first-class; today we fake it by reusing the same `agentId` or replicating secret assignments in `src/onecli-secrets.ts`.
- Host creates a **fresh** worktree at `.worktrees/dev-<request-id>` on branch `dev/<request-id>`, then applies the runner and skills overlays from the originating group's private dirs. Shadows `.env`, excludes `data/` and `store/` (except the carve-outs declared in the Per-Group Copy Architecture section).
- Host mounts the worktree into the dev agent's container at `/worktree` (additional writable volume). The dev agent's standard runtime mounts are unchanged — it's running the live version, editing the worktree copy.
- Host delivers the user's request summary to the dev agent as a system message via the normal session DB path.

### 3. Dev agent works

- Reads context from the whole worktree.
- Edits anywhere in the worktree except excluded paths. No filesystem-level scope restriction — dev agent can touch `src/`, `container/agent-runner/src/`, `container/skills/`, `groups/<originating>/`, `package.json`, `Dockerfile`, migrations. Classification (and the consequent approval path) happens later, not now.
- No web access. Tool allowlist is a reduced variant (file edit, git, local build/test).
- Can message agent-A for clarification via the standard destinations flow.
- Commits to the dev branch in the worktree when ready.

### 4. Pre-swap handshake with originating agent

Before submitting the swap request to the host, the dev agent clears it with agent-A:

1. Dev agent → agent-A: "Ready to propose these changes: {overall summary}. OK to submit for approval?"
2. Agent-A (likely confirming with the user): "yes, submit."
3. Dev agent → host: `request_swap(per_file_summaries, overall_summary, commit_sha)` MCP tool.

Per-file summaries and overall summary are required — host rejects the swap request if either is missing or empty. These summaries become the human-readable portion of the approval card.

### 5. Host classifies the diff

Host runs `git diff --name-only` in the worktree against `main`. Every changed path is classified:

**Group-level** (group admin approves):
- `groups/<originating>/**` — the originating group's own memory/CLAUDE.md/skills
- `container/agent-runner/src/**` — targets the originating group's **private runner copy**, not the repo template
- `container/skills/**` — targets the originating group's **private skills copy**, not the repo template

**Host-level** (owner only + typed confirmation):
- `src/**` — host code, affects everyone
- `scripts/**`, `setup/**`
- Root `package.json`, `package-lock.json`, `Dockerfile`, `tsconfig.json`
- `container/Dockerfile` (shared container image)
- `src/db/migrations/**` (flagged as non-rollback-safe)
- `docs/**`, `README.md`
- `groups/<other>/**` — touching another group's folder is never allowed through this flow; classify as host-level so it requires owner consent (but in practice the approval message should call it out as "touching another group's data" specifically)

**Combined (host + group runner/skills) — still host-level, but with a cross-group safety warning:** if the diff contains both host-level paths AND `container/agent-runner/src/**` or `container/skills/**`, the approval card includes an extra prominent warning (see §6).

**Never writable** (filesystem-excluded from worktree): `data/**`, `store/**`, `.env`, `.env.*`.

Classification is purely about **approval routing and swap targets**, not about what the dev agent was allowed to write. The dev agent always has full worktree write access.

### 6. Approval card

Host sends an approval card via `pending_approvals` to the appropriate approver.

**Group-level diff:**
- Approver: group admin of the originating group (via `pickApprover` → `pickApprovalDelivery`).
- Card: overall summary + per-file summaries + raw diff + in-flight work notice + deadman reminder + Approve / Reject.

**Host-level diff:**
- Approver: **owner only** (not escalated through scoped or global admin).
- Card: same as group-level, plus:
  - Prominent warning banner: "Host-level changes run with full credential scope and can access data across all groups. Review carefully."
  - **Typed confirmation required** — approver must type a confirmation word (e.g. `CONFIRM HOST`) before the Approve button activates. Guards against fat-finger approvals on mobile.
  - Schema-migration warning if `src/db/migrations/**` is in the diff — rollback may be lossy.
  - **Cross-group safety warning** if the diff also includes runner/skills changes:
    > "This change modifies host code **and** per-group runner/skills code. Host changes will apply to every group on next restart. Runner/skills changes will only apply to the originating group. Other existing groups will continue running their old runner against the new host — this can break them if the host change requires a matching runner update. If that happens, you can run another dev-agent cycle from each affected group to refresh them."

Rejection at any point throws the diff away and tears down the worktree.

### 7. Swap dance (on approval)

0. **Reject if another swap is in flight for this originating group.** Plan enforces one swap per originating group at a time via a row lock on `pending_swaps`. A second approval arriving while another is mid-dance is impossible by construction; a second `request_swap` from the dev agent while the previous swap is awaiting approval gets rejected with "previous swap still pending — resolve it first."
1. **Capture pre-swap state** — record main's current HEAD SHA in `pending_swaps.pre_swap_sha` (used for rollback) and snapshot the central DB to `data/backups/swap-<request-id>.sqlite` (path stored in `pending_swaps.db_snapshot_path`).
2. **Apply the diff to swap targets** — host walks the diff by path and maps each changed file to its destination:
   - `<worktree>/container/agent-runner/src/FILE` → `data/v2-sessions/<originating-id>/agent-runner-src/FILE`
   - `<worktree>/container/skills/FILE` → `data/v2-sessions/<originating-id>/.claude-shared/skills/FILE`
   - `<worktree>/groups/<originating>/FILE` → `groups/<originating>/FILE` (in the repo, same path)
   - `<worktree>/src/FILE` → `src/FILE` (host code, in the repo)
   - `<worktree>/container/Dockerfile` → `container/Dockerfile` (in the repo)
   - `<worktree>/package.json` → `package.json` (in the repo)
   - etc.
3. **Commit the swap** — host uses `git commit --only <touched-paths>` to commit exactly the swap's files to main with message `swap <request-id>: <overall_summary>`, leaving any unrelated uncommitted state in main alone. If git is in a weird state (mid-merge, mid-rebase, detached HEAD), the swap is refused with a clear error surfaced back to the approver — no auto-resolution, no stashing. `pre_swap_sha` + git is the rollback mechanism.
4. **Conditional rebuild** — if the diff touches the container Dockerfile, root `package.json`, or similar image-affecting files, rebuild the affected image(s). Detect via classifier output. Group-local Dockerfile edits (if we ever add that) would trigger a per-group image rebuild; root Dockerfile / host package.json edits trigger a host-wide rebuild.
5. **Restart affected processes.**
   - Group-level diff → restart only the originating agent's container. It re-mounts `agent-runner-src/` and `.claude-shared/skills/`, picking up the updated per-group copies.
   - Host-level diff → restart the host process. All channels reconnect; active sessions resume on next message.
6. **Start the deadman timer** — 2 minutes initially, extendable (see §8).
7. **Post-restart handshake begins** — agent-A (now running the new code) sends the user a confirmation message.

### 8. Deadman dance

Deadman runs for **both** group-level and host-level swaps. Two-message handshake verifying both inbound and outbound paths work under the new code:

1. Agent-A → user: "I'm back with the new version. Reply `confirm` to keep it, or `rollback` to revert."
2. User → agent-A: `confirm`.

On step 2, host cancels the timer and the swap is finalized. Two messages is enough: step 1 proves outbound delivery works under the new code, and step 2 arriving and being processed proves inbound routing + agent handling work.

**Timer state is persisted** in `pending_swaps` (`deadman_started_at`, `deadman_expires_at`, `handshake_state`). The in-memory `setTimeout` is just the trigger — the source of truth is the DB row. This is what makes host-level swaps work across the expected host restart, and what makes group-level swaps survive an unexpected host crash.

**Timer extension on progress:** if step 1 is successfully delivered to the user, update `deadman_expires_at` to +2 minutes from now and reset the in-memory timer. Slow channel reconnects (WhatsApp Baileys: 30–120s) should not trigger false rollback once we know outbound is flowing. Hard cap: 10 minutes absolute maximum.

**Explicit rollback:** user can reply `rollback` at step 2 (instead of `confirm`) to trigger immediate rollback without waiting for the timer.

**On timer expiry without step 2:**
1. Host runs `git checkout <pending_swaps.pre_swap_sha> -- <affected-paths>` to restore every file modified by the swap, then records a forward-only revert commit on main: `rollback <request-id>: deadman timeout`. One mechanism — git — handles both restore and audit trail.
2. Restores the central DB from the snapshot at `pending_swaps.db_snapshot_path`.
3. Restarts the originating agent's container (group-level) or the host (host-level).
4. Notifies the user via any working channel: "Rolled back to previous version — confirmation timed out."

**Resume on host startup:** the host startup sequence (see `builder-agent/startup.ts`) scans `pending_swaps` for any row in `awaiting_confirmation` status:
- If `handshake_state = 'pending_restart'` (host-level swap finished the restart; now running the new code): send handshake message 1 to the user, update state to `message1_sent`, start in-memory timer for the remaining time in `deadman_expires_at`.
- If `handshake_state = 'message1_sent'` (host or container crashed while waiting for user reply): don't resend, just reschedule the timer for the remaining time.
- If `deadman_expires_at <= now`: expired, execute rollback immediately.

This one code path covers both the expected host-level restart and any unexpected host crash mid-dance. ~50 LOC total in `startup.ts` including the orphan-worktree cleanup.

### 9. Promote to template (post-finalize)

If the finalized diff touched `container/agent-runner/src/**` or `container/skills/**` — regardless of whether it was classified group-level or host-level-combined — host sends a follow-up card to the same approver:

> "The runner/skills changes are currently applied only to the {originating} group. Would you like to also apply them to the template so new groups created in the future inherit these changes? (Existing groups will not be affected.)"

Options: `Apply to template` / `Keep local to {originating}`. No defer — the prompt is decide-now-or-never to avoid a lifecycle management burden.

On `Apply to template`: host copies the same files from `<worktree>` to `container/agent-runner/src/` and/or `container/skills/` **in the main repo**, commits (`promote <request-id>: <paths> → template`), and done. New groups initialized after this point get the updated template as their starting copy. Existing groups (including the originating one, which already has its private copy updated) are unaffected.

On `Keep local`: nothing further happens. Changes stay in the originating group's private copy.

**Not in v1:** bulk refresh of other existing groups when a combined host + runner diff lands. The cross-group safety warning on the host-level approval card (§6) sets expectations. If a user hits real breakage, they run another dev-agent cycle from each affected group to refresh its private copy. Revisit if this becomes a real pain point.

## Code Affected

### New modules

- `src/builder-agent/worktree.ts` — worktree creation with overlay from per-group private dirs, shadow `.env`, exclude `data/`/`store/`, dev branch lifecycle. Crash cleanup is a simple startup sweep (see below), not runtime bookkeeping.
- `src/builder-agent/classifier.ts` — diff classification by path, following the rules in §5. Exports structured output (list of changes with their classification + swap target).
- `src/builder-agent/swap.ts` — captures `pre_swap_sha` + DB snapshot, applies diff to swap targets, commits via `git commit --only <paths>` to main, refuses if git is in a weird state, conditional rebuild, restart orchestration.
- `src/builder-agent/deadman.ts` — in-memory timer backed by `pending_swaps` row, extension logic, handshake state tracking, rollback via `git checkout <pre_swap_sha>` + revert commit + DB snapshot restore. Runs for both group-level and host-level swaps.
- `src/builder-agent/promote.ts` — post-finalization prompt for promoting runner/skills changes to the template.
- `src/builder-agent/approval.ts` — approval-card rendering for swap requests and the typed-confirmation gate for host-level approvals. Built on `pending_approvals` directly (swap approvals are not credential operations; they have nothing to do with `onecli-approvals.ts`).
- `src/builder-agent/startup.ts` — runs on host startup: (a) resume any `pending_swaps` row in `awaiting_confirmation` status (see §8 "Resume on host startup" — handles both host-level expected restarts and unexpected group-level host crashes with one code path); (b) delete any `.worktrees/dev-*` dir whose corresponding row is in a terminal state or has no row. ~50 LOC total including resume + orphan cleanup.
- `src/db/migrations/NNN_builder_agent.sql` — one new table:
  - `pending_swaps` — `request_id`, `dev_agent_id`, `originating_group_id`, `dev_branch`, `commit_sha`, `classification` (group|host|combined), `status`, `summary_json`, `pre_swap_sha`, `db_snapshot_path`, `deadman_started_at`, `deadman_expires_at`, `handshake_state`. Everything swap-lifecycle fits on one row.

### New MCP tools (container)

- `request_dev_changes(summary, dev_agent_name?)` — on originating agent; host spawns dev agent + worktree.
- `request_swap(per_file_summaries, overall_summary, commit_sha)` — on dev agent; host classifies + routes for approval.

### Modified

- `src/container-runner.ts` — support an extra writable worktree mount for dev agents; same per-group mounts otherwise. The dev agent runs the **standard** agent-runner image — no dev-specific variant. Tool restrictions (no web, etc.) are enforced via the agent-runner's existing tool allowlist mechanism, configured per session.
- `src/group-init.ts` — no changes required, but verify that promote-to-template copies land in the right place for future groups to pick up.
- `src/access.ts` / `src/db/users.ts` — `pickApprover` variant that skips escalation and targets owner only for host-level diffs.
- `src/delivery.ts` — no new logic; existing ACL already handles dev-agent destinations.

### Not touched

- `container/agent-runner/**` — **no dev-agent variant.** The standard agent-runner is reused as-is; the dev agent is just a clone with a different tool allowlist and an extra mount.
- `src/onecli-approvals.ts` — **unrelated.** Swap approvals use `pending_approvals` directly via the new `builder-agent/approval.ts`. OneCLI approvals are for credential-gating operations only.

### Tests (v1)

- Unit tests for `classifier`, `swap` target mapping, `deadman` state machine, `startup-sweep`. ~400–600 LOC.
- **No end-to-end integration test** in v1 — exercising real container/host restarts in CI is expensive and can be added later. Manual testing during development covers the full flow.

## OneCLI Dependencies (Upstream)

- **Parent-child agent privilege inheritance** — `onecli agents create --inherit-from <parent-agent-id>`. Today we fake it (same `agentId` or replicated secret assignments). Not blocking for v1 of this feature but makes the wiring cleaner.
- **Agent-scoped tool allowlists** — nice to have to ensure the dev agent variant cannot invoke web tools even if present in its image. Not blocking; we enforce at the container-runner tool-allowlist level.

## Decisions

1. **Dev agent lifecycle** — **fresh dev agent group per request**, with an optional name supplied by the originating agent so it has a stable conversational identity. Previous dev agent is kept alive between requests (originating agent can chat with it indefinitely after the prior request finalized) and is torn down the moment a new `request_dev_changes` arrives. One live dev agent at a time per originating group.
2. **Worktree reuse across requests** — **fresh per request.** New worktree, new overlays, new dev branch every time.
3. **Live CLAUDE.md race** — **accept the race.** No locking. Dev cycles are short and the race window is small; swap overwrites whatever the originating agent wrote in the meantime. Revisit if it becomes a real problem in practice.
4. **Schema migrations in host-level diffs** — **allowed with warning.** Classifier flags the approval card with "rollback may be lossy if migration is non-reversible." Owner decides.
5. **Parallel dev-agent flows** — **serialized.** One in-flight swap per originating group at a time, enforced by a `pending_swaps` row lock. Second `request_swap` while the previous is pending approval gets rejected.
6. **Bulk refresh on combined host + runner diffs** — **not in v1.** The cross-group safety warning on the approval card sets expectations. If a user hits real breakage, they run another dev-agent cycle from each affected group to refresh its private copy. Revisit if it becomes a real pain point.
7. **Tracking per-group src code history** — **un-gitignore the per-group carve-outs**, track them in main. Every swap is a commit touching the per-group paths (and host paths if applicable); rollback is a forward-only revert commit. One git history covers host code, template, and every group's private state.

## Deliberate Simplifications

To keep the implementation surface small, v1 explicitly does not handle:

- **Git in a weird state** (mid-merge, mid-rebase, detached HEAD): swap is refused with a clear error surfaced to the approver. No stashing, no auto-resolution.
- **Runtime worktree bookkeeping for crashes:** crash recovery is a single startup sweep that resumes pending deadmans and deletes orphan worktrees. No in-flight crash tracking, no leases.
- **End-to-end integration tests:** unit tests only for v1. Full container/host-restart integration test is a follow-up.
- **No separate dev-agent runner image:** dev agent reuses the standard agent-runner with a different tool allowlist and an extra mount. Zero delta in `container/agent-runner/**`.
- **Bulk refresh of other groups** on combined host + runner diffs (see §9): warning on approval card sets expectations; user runs another dev-agent cycle per affected group if they hit real breakage.

## Remaining Open Questions

None blocking — plan is ready to implement.

## Replaces

This plan replaces the `Self-modification via builder-agent delegation` sub-block in `docs/v2-checklist.md`. Once agreed, update the checklist to collapse those subtasks into a single line pointing here.
