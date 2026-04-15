/**
 * Host-side handlers for builder-agent system actions dispatched from
 * `src/delivery.ts::handleSystemAction`. Two actions live here:
 *
 *   - `create_dev_agent` — originating agent asks to spawn a fresh dev
 *     agent. Two-step model: this handler only CREATES the dev agent
 *     group, its worktree, destinations, and the pending_swaps row. It
 *     does NOT start any work. The originating agent is expected to then
 *     send a message to the dev agent via its destination to describe
 *     the task. This keeps the MCP tool call cheap and makes the work
 *     instructions first-class inbound chat that the user/originating
 *     agent can review or edit.
 *
 *   - `request_swap` — dev agent has finished editing and wants to submit
 *     for approval. We look up the pending_swaps row by dev_agent_id, run
 *     `git diff` in the worktree, classify by path, persist, and route the
 *     approval card.
 *
 * Both handlers are fire-and-forget at the MCP-tool layer: the container
 * tool writes a message_out and returns immediately; any failure is
 * surfaced back to the caller via `notifyAgent`.
 */
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { killContainer } from '../container-runner.js';
import { createAgentGroup, deleteAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import { findSessionByAgentGroup } from '../db/sessions.js';
import {
  createDestination,
  deleteAllDestinationsTouching,
  getDestinationByName,
  normalizeName,
} from '../db/agent-destinations.js';
import { getDb } from '../db/connection.js';
import {
  createPendingSwap,
  getInFlightSwapForGroup,
  getSwapForDevAgent,
  updatePendingSwapStatus,
} from '../db/pending-swaps.js';
import { initGroupFilesystem } from '../group-init.js';
import { log } from '../log.js';
import { writeDestinations } from '../session-manager.js';
import type { AgentGroup, Session, SwapClassification } from '../types.js';
import { sendSwapApprovalCard } from './approval.js';
import { classifyDiff } from './classifier.js';
import { createDevWorktree, diffChangedPathsAtCommit, removeDevWorktree, worktreeHeadSha } from './worktree.js';

type NotifyFn = (session: Session, text: string) => void;

export interface CreateDevAgentContent {
  requestId: string;
  name: string;
}

export interface RequestSwapContent {
  perFileSummaries: Record<string, string>;
  overallSummary: string;
}

const DEV_AGENT_INSTRUCTIONS = `# Dev Agent

You are a dev agent spawned by the builder-agent self-modification flow. Your job is to make code changes that the originating agent (your \`parent\`) will describe to you in an inbound message, then propose the diff for admin approval. You work in an isolated git worktree mounted at \`/worktree\`.

## Bootstrapping: wait for your first task

When you spawn, there is nothing to do yet. Sit idle until your first inbound message from \`parent\` arrives — that message contains the task description. Do not start exploring the worktree before then.

## Your environment

- \`/worktree\` — a full copy of the NanoClaw repo, writable. Edit anything here.
- \`data/\`, \`store/\`, \`.env\` inside the worktree are excluded/shadowed — you cannot read real credentials from them.
- You run the same code and tools as your parent, but with NO web access.
- You have \`git\` available inside \`/worktree\`. Commit your changes on the dev branch when ready.

## The flow

1. Wait for the parent's task in your first inbound message.
2. Explore the worktree at \`/worktree\` to understand the code.
3. Message your \`parent\` destination whenever you need clarification.
4. Make the edits and \`git commit\` them in the worktree.
5. When ready, message your parent: "Ready to propose these changes: {summary}. OK to submit for approval?"
6. After the parent confirms, call the \`request_swap\` MCP tool with a per-file summary and an overall summary. The host takes it from there (classification, approval routing, swap dance, deadman).

You do not execute the swap yourself — the host does, after an admin approves. Your job ends at \`request_swap\`.

**Do not edit your own agent-group folder.** Your edits target \`/worktree\`, not your runtime. Trying to modify your own CLAUDE.md is both pointless (you run on the live version, not the copy) and confusing.
`;

/**
 * Tear down any previous in-flight dev agent for this originating group.
 * Called at the start of `handleRequestDevChanges`. Per decision #1 in the
 * plan: the originating agent may chat with a prior dev agent after its
 * request finalized, but the moment a NEW request comes in, the old dev
 * agent is wound down.
 */
function teardownPreviousDevAgent(originatingGroupId: string, originatingSession: Session): void {
  const prior = getInFlightSwapForGroup(originatingGroupId);
  if (!prior) return;

  log.info('Tearing down previous dev agent before new request', {
    priorRequestId: prior.request_id,
    priorDevAgentId: prior.dev_agent_id,
    originatingGroupId,
  });

  updatePendingSwapStatus(prior.request_id, 'rolled_back');
  try {
    removeDevWorktree(prior.request_id);
  } catch (err) {
    log.warn('Failed to remove prior worktree', { priorRequestId: prior.request_id, err });
  }
  try {
    deleteAllDestinationsTouching(prior.dev_agent_id);
    // REQUIRED: refresh the parent's destination projection after dropping
    // the prior dev-agent's rows, so its `dev-<name>` destination
    // disappears from the parent's running inbound.db. See the top-of-file
    // invariant in src/db/agent-destinations.ts.
    writeDestinations(originatingGroupId, originatingSession.id);
  } catch (err) {
    log.warn('Failed to drop prior dev-agent destinations', { priorDevAgentId: prior.dev_agent_id, err });
  }
  try {
    deleteAgentGroup(prior.dev_agent_id);
  } catch (err) {
    log.warn('Failed to delete prior dev agent group', { priorDevAgentId: prior.dev_agent_id, err });
  }
}

/**
 * Handle a `create_dev_agent` system action from an originating agent.
 * Creates the dev agent group, worktree, destinations, and pending_swaps
 * row. Does NOT start any work — the originating agent is expected to
 * message the dev agent via its destination with the task details next.
 */
export async function handleCreateDevAgent(
  content: CreateDevAgentContent,
  session: Session,
  notifyAgent: NotifyFn,
): Promise<void> {
  const requestId = content.requestId;
  const rawName = (content.name || '').trim();
  if (!rawName) {
    notifyAgent(session, 'create_dev_agent failed: name is required.');
    return;
  }

  const originatingGroup = getAgentGroup(session.agent_group_id);
  if (!originatingGroup) {
    notifyAgent(session, 'create_dev_agent failed: originating agent group not found.');
    log.warn('create_dev_agent: missing originating group', {
      sessionAgentGroup: session.agent_group_id,
    });
    return;
  }

  // Tear down any prior in-flight dev agent for this originating group.
  teardownPreviousDevAgent(originatingGroup.id, session);

  // Sanitize + dedupe the destination name.
  const localName = normalizeName(rawName);
  if (getDestinationByName(originatingGroup.id, localName)) {
    notifyAgent(
      session,
      `create_dev_agent failed: you already have a destination named "${localName}". Pick a different name.`,
    );
    return;
  }

  // Derive a safe folder name, deduplicated globally across agent_groups.folder.
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }
  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    notifyAgent(session, 'create_dev_agent failed: invalid folder path.');
    log.error('create_dev_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const devAgentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const devGroup: AgentGroup = {
    id: devAgentGroupId,
    name: localName,
    folder,
    agent_provider: originatingGroup.agent_provider,
    created_at: now,
  };

  try {
    createAgentGroup(devGroup);
    initGroupFilesystem(devGroup, { instructions: DEV_AGENT_INSTRUCTIONS });

    // Bidirectional destinations: parent calls child by localName, child
    // calls parent as "parent" (or parent-N on collision).
    createDestination({
      agent_group_id: originatingGroup.id,
      local_name: localName,
      target_type: 'agent',
      target_id: devAgentGroupId,
      created_at: now,
    });
    let parentName = 'parent';
    let parentSuffix = 2;
    while (getDestinationByName(devAgentGroupId, parentName)) {
      parentName = `parent-${parentSuffix}`;
      parentSuffix++;
    }
    createDestination({
      agent_group_id: devAgentGroupId,
      local_name: parentName,
      target_type: 'agent',
      target_id: originatingGroup.id,
      created_at: now,
    });

    // Fresh worktree per request (decision #2 in plan).
    createDevWorktree(requestId, originatingGroup.id);

    // REQUIRED: project the new `dev-<name>` destination into the
    // originating agent's session inbound.db so the running container
    // sees it on its next send_message lookup. See the top-of-file
    // invariant in src/db/agent-destinations.ts.
    writeDestinations(originatingGroup.id, session.id);

    // Persist the pending_swaps row. commit_sha / pre_swap_sha / db_snapshot
    // / deadman fields start null — populated at request_swap time and/or
    // approval time. summary_json starts empty; handleRequestSwap fills it
    // when the dev agent submits.
    createPendingSwap({
      request_id: requestId,
      dev_agent_id: devAgentGroupId,
      originating_group_id: originatingGroup.id,
      dev_branch: `dev/${requestId}`,
      commit_sha: '',
      classification: 'group',
      status: 'pending_approval',
      summary_json: JSON.stringify({}),
      pre_swap_sha: null,
      db_snapshot_path: null,
      deadman_started_at: null,
      deadman_expires_at: null,
      handshake_state: null,
      created_at: now,
    });
  } catch (err) {
    log.error('create_dev_agent failed mid-setup', { err, requestId, devAgentGroupId });
    try {
      removeDevWorktree(requestId);
    } catch {
      /* best effort */
    }
    try {
      deleteAllDestinationsTouching(devAgentGroupId);
      // REQUIRED: refresh the parent's destination projection after
      // dropping the partially-created dev-agent's rows. See the
      // top-of-file invariant in src/db/agent-destinations.ts.
      writeDestinations(originatingGroup.id, session.id);
    } catch {
      /* best effort */
    }
    try {
      deleteAgentGroup(devAgentGroupId);
    } catch {
      /* best effort */
    }
    notifyAgent(
      session,
      `create_dev_agent failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  notifyAgent(
    session,
    `Dev agent "${localName}" created and is waiting for your first message. Send it the task details now with <message to="${localName}">...describe the change you want...</message>. It will NOT start until you message it.`,
  );
  log.info('Dev agent + worktree created', {
    requestId,
    devAgentGroupId,
    originatingGroupId: originatingGroup.id,
    localName,
  });
}

/**
 * Handle a `request_swap` system action from a dev agent.
 *
 * Slice 2 scope: look up the pending_swaps row by dev_agent_id, run
 * `git diff` in the worktree, classify, persist. Approval routing and
 * the swap execution live in Slice 3.
 */
export async function handleRequestSwap(
  content: RequestSwapContent,
  session: Session,
  notifyAgent: NotifyFn,
): Promise<void> {
  const devGroup = getAgentGroup(session.agent_group_id);
  if (!devGroup) {
    notifyAgent(session, 'Code change submission failed: dev agent group not found.');
    return;
  }

  const pending = getSwapForDevAgent(devGroup.id);
  if (!pending) {
    notifyAgent(session, 'Code change submission failed: no in-flight code change for this dev agent.');
    return;
  }

  const overall = (content.overallSummary || '').trim();
  const perFile = content.perFileSummaries || {};
  if (!overall || Object.keys(perFile).length === 0) {
    notifyAgent(session, 'Code change submission failed: overallSummary and perFileSummaries are both required.');
    return;
  }

  // Capture HEAD first, THEN read the commit-based diff. The agent is
  // still running at this point, so any working-tree noise must be
  // excluded — we only consider what's in the committed tree at this sha.
  let headSha: string;
  let changedPaths: string[];
  try {
    headSha = worktreeHeadSha(pending.request_id);
    changedPaths = diffChangedPathsAtCommit(pending.request_id, headSha);
  } catch (err) {
    notifyAgent(
      session,
      `Code change submission failed: could not read worktree diff (${err instanceof Error ? err.message : String(err)}).`,
    );
    return;
  }

  if (changedPaths.length === 0) {
    notifyAgent(
      session,
      "Code change submission failed: no committed changes in the worktree. Did you forget to `git commit`? Uncommitted working-tree edits don't count — only the committed tree is reviewed.",
    );
    return;
  }

  let classified;
  try {
    classified = classifyDiff(changedPaths, {
      projectRoot: process.cwd(),
      dataDir: path.resolve(process.cwd(), 'data'),
      originatingGroupId: pending.originating_group_id,
      originatingGroupFolder: getAgentGroup(pending.originating_group_id)?.folder ?? '',
    });
  } catch (err) {
    notifyAgent(
      session,
      `Code change submission failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  updatePendingSwapRow(pending.request_id, {
    commit_sha: headSha,
    classification: classified.overall,
    summary_json: JSON.stringify({
      overallSummary: overall,
      perFileSummaries: perFile,
      classifiedFiles: classified.files.map((f) => ({ path: f.path, classification: f.classification })),
      touchesMigrations: classified.touchesMigrations,
    }),
  });

  notifyAgent(
    session,
    `Code change registered for ${classified.files.length} file(s). Classification: ${classified.overall}. Sending for admin approval…`,
  );
  log.info('request_swap classified', {
    requestId: pending.request_id,
    devAgentId: devGroup.id,
    classification: classified.overall,
    fileCount: classified.files.length,
    touchesMigrations: classified.touchesMigrations,
  });

  // Freeze: kill the dev agent's container now that commit_sha is set.
  // The spawn gate in container-runner.ts will refuse to bring it back
  // while pending_swaps.commit_sha is non-empty and status is non-terminal.
  // This prevents the dev agent from editing /worktree between submission
  // and approval/rollback, which would otherwise let un-reviewed content
  // land on main because applySwapFiles reads from commit_sha (below).
  killContainer(session.id, 'frozen for code-change approval');

  // Route the approval card to the originating agent's session context so
  // the approver ladder picks the right person (group admin vs owner).
  const originatingSession = findSessionByAgentGroup(pending.originating_group_id);
  if (!originatingSession) {
    notifyAgent(
      session,
      'Code change approval could not be routed: the originating agent has no active session. An operator will need to resolve the pending_swaps row manually.',
    );
    return;
  }

  const updatedSwap = {
    ...pending,
    commit_sha: headSha,
    classification: classified.overall,
    summary_json: JSON.stringify({
      overallSummary: overall,
      perFileSummaries: perFile,
      classifiedFiles: classified.files.map((f) => ({ path: f.path, classification: f.classification })),
      touchesMigrations: classified.touchesMigrations,
    }),
  };
  await sendSwapApprovalCard(updatedSwap, originatingSession, (text) => notifyAgent(session, text));
}

/**
 * Targeted UPDATE helper — avoids adding a dedicated DB helper per field
 * combination. Prepared statement is built once per call from the patch
 * shape; parameter count always matches.
 */
function updatePendingSwapRow(
  requestId: string,
  patch: { commit_sha?: string; classification?: SwapClassification; summary_json?: string },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.commit_sha !== undefined) {
    sets.push('commit_sha = ?');
    values.push(patch.commit_sha);
  }
  if (patch.classification !== undefined) {
    sets.push('classification = ?');
    values.push(patch.classification);
  }
  if (patch.summary_json !== undefined) {
    sets.push('summary_json = ?');
    values.push(patch.summary_json);
  }
  if (sets.length === 0) return;
  values.push(requestId);
  getDb()
    .prepare(`UPDATE pending_swaps SET ${sets.join(', ')} WHERE request_id = ?`)
    .run(...values);
}
