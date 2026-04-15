/**
 * Promote-to-template flow.
 *
 * Runs once a swap is finalized (user clicked Confirm in the deadman). If
 * the diff touched `container/agent-runner/src/**` or `container/skills/**`,
 * we offer the approver a follow-up card:
 *
 *   "The runner/skills changes are currently applied only to the
 *    {originating} group. Would you like to also apply them to the
 *    template so new groups created in the future inherit these changes?"
 *
 * Options: `Apply to template` / `Keep local to {originating}`. Decide-now-
 * or-never — no "Ask me later" state, no lifecycle management burden.
 *
 * On apply: copy files from the originating group's committed private dir
 * (`data/v2-sessions/<id>/agent-runner-src/**`, etc.) to the repo template
 * paths (`container/agent-runner/src/**`, `container/skills/**`), commit.
 * New groups initialized after this point inherit the updated template.
 * Existing groups are untouched.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { pickApprovalDelivery, pickApprover } from '../access.js';
import { DATA_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { createPendingApproval, deletePendingApproval, findSessionByAgentGroup } from '../db/sessions.js';
import { getOwners } from '../db/user-roles.js';
import { log } from '../log.js';
import type { PendingSwap } from '../types.js';
import { parseSwapSummary } from './swap.js';

const PROJECT_ROOT = process.cwd();

export interface PromoteDelivery {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
  ): Promise<string | undefined>;
}

let deliveryRef: PromoteDelivery | null = null;

export function setPromoteDelivery(adapter: PromoteDelivery): void {
  deliveryRef = adapter;
}

/**
 * True iff any path in the swap's diff maps to runner or skills template.
 * Used by the finalize path to decide whether to trigger the prompt.
 */
export function swapTouchedRunnerOrSkills(swap: PendingSwap): boolean {
  const summary = parseSwapSummary(swap);
  return summary.classifiedFiles.some(
    (f) =>
      f.path.startsWith('container/agent-runner/src/') ||
      f.path.startsWith('container/skills/'),
  );
}

/**
 * Send the promote-to-template prompt to the approver of the original
 * swap. Routing is the same as the original approval card — group admin
 * for group-level, owner-only for host-level-combined. No-ops if the
 * swap didn't touch runner/skills.
 */
export async function maybeSendPromotePrompt(swap: PendingSwap): Promise<void> {
  if (!swapTouchedRunnerOrSkills(swap)) return;
  if (!deliveryRef) {
    log.warn('maybeSendPromotePrompt: no delivery adapter set', { requestId: swap.request_id });
    return;
  }

  const isHostLevel = swap.classification === 'host' || swap.classification === 'combined';
  const approvers = isHostLevel
    ? getOwners().map((r) => r.user_id)
    : pickApprover(swap.originating_group_id);

  if (approvers.length === 0) {
    log.info('Skipping promote prompt: no approvers configured', { requestId: swap.request_id });
    return;
  }

  const originatingSession = findSessionByAgentGroup(swap.originating_group_id);
  const originChannelType = originatingSession?.messaging_group_id
    ? (getMessagingGroup(originatingSession.messaging_group_id)?.channel_type ?? '')
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    log.info('Skipping promote prompt: no reachable approver', { requestId: swap.request_id });
    return;
  }

  const originatingGroup = getAgentGroup(swap.originating_group_id);
  const originatingName = originatingGroup?.name ?? swap.originating_group_id;

  const approvalId = `promote-${swap.request_id}`;
  const options = [
    { label: 'Apply to template', selectedLabel: '✅ Promoted', value: 'apply' },
    { label: `Keep local to ${originatingName}`, selectedLabel: '↪️  Kept local', value: 'keep' },
  ];

  createPendingApproval({
    approval_id: approvalId,
    session_id: originatingSession?.id ?? null,
    request_id: swap.request_id,
    action: 'promote_template',
    payload: JSON.stringify({ swapRequestId: swap.request_id }),
    created_at: new Date().toISOString(),
    title: 'Promote to template?',
    options_json: JSON.stringify(options),
  });

  const summary = parseSwapSummary(swap);
  const runnerOrSkills = summary.classifiedFiles
    .filter((f) => f.path.startsWith('container/agent-runner/src/') || f.path.startsWith('container/skills/'))
    .map((f) => `- \`${f.path}\``)
    .join('\n');

  const body =
    `Code change confirmed. The runner/skills edits are currently applied only to the **${originatingName}** agent.\n\n` +
    `**Files that could also become the default for new agents:**\n${runnerOrSkills}\n\n` +
    `Apply to template so agents created in the future inherit these changes? ` +
    `(Existing agents are unaffected either way.)`;

  try {
    await deliveryRef.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title: 'Promote to template?',
        question: body,
        options,
      }),
    );
    log.info('Promote prompt delivered', {
      requestId: swap.request_id,
      approvalId,
      approver: target.userId,
    });
  } catch (err) {
    log.error('Promote prompt delivery failed', { requestId: swap.request_id, err });
  }
}

/**
 * Called by `handleApprovalResponse` in index.ts when the approver clicks
 * a button on the promote prompt. `apply` copies the runner/skills files
 * from the originating group's private dir into the repo template and
 * commits; anything else is a no-op.
 */
export async function handlePromoteResponse(
  approvalId: string,
  swapRequestId: string,
  selectedOption: string,
): Promise<void> {
  try {
    if (selectedOption === 'apply') {
      await applyToTemplate(swapRequestId);
    } else {
      log.info('Promote skipped by approver', { swapRequestId, selectedOption });
    }
  } finally {
    deletePendingApproval(approvalId);
  }
}

async function applyToTemplate(swapRequestId: string): Promise<void> {
  // Re-read the row directly (we need fresh state in case anything touched
  // it since finalize).
  const { getPendingSwap } = await import('../db/pending-swaps.js');
  const swap = getPendingSwap(swapRequestId);
  if (!swap) {
    log.warn('applyToTemplate: swap not found', { swapRequestId });
    return;
  }

  const summary = parseSwapSummary(swap);
  const runnerOrSkills = summary.classifiedFiles.filter(
    (f) =>
      f.path.startsWith('container/agent-runner/src/') ||
      f.path.startsWith('container/skills/'),
  );
  if (runnerOrSkills.length === 0) return;

  const copiedRelPaths: string[] = [];
  for (const f of runnerOrSkills) {
    // The source is the originating group's committed private copy, which
    // lives under data/v2-sessions/<id>/... thanks to the gitignore carve-
    // out. The destination is the repo template path at `f.path`.
    const src = sourceForTemplate(f.path, swap.originating_group_id);
    const dst = path.join(PROJECT_ROOT, f.path);
    if (!fs.existsSync(src)) {
      // File was deleted — mirror into the template.
      if (fs.existsSync(dst)) fs.rmSync(dst);
      copiedRelPaths.push(f.path);
      continue;
    }
    const dir = path.dirname(dst);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, dst);
    copiedRelPaths.push(f.path);
  }

  if (copiedRelPaths.length === 0) return;

  try {
    execFileSync('git', ['add', '--', ...copiedRelPaths], { cwd: PROJECT_ROOT, stdio: 'ignore' });
    execFileSync(
      'git',
      ['commit', '-m', `promote ${swapRequestId}: ${copiedRelPaths.join(', ')} → template`, '--', ...copiedRelPaths],
      { cwd: PROJECT_ROOT, stdio: 'ignore' },
    );
    log.info('Promote to template committed', { swapRequestId, paths: copiedRelPaths });
  } catch (err) {
    log.error('Promote to template git operations failed', { swapRequestId, err });
  }
}

/**
 * Compute the on-disk source path that corresponds to a repo template
 * path for a given originating group. This is the reverse of the
 * classifier's group-level target mapping.
 *
 * Exported for tests so the mapping stays in sync with the classifier.
 */
export function sourceForTemplate(templatePath: string, originatingGroupId: string): string {
  const norm = templatePath.replace(/\\/g, '/');
  if (norm.startsWith('container/agent-runner/src/')) {
    const rel = norm.slice('container/agent-runner/src/'.length);
    return path.join(DATA_DIR, 'v2-sessions', originatingGroupId, 'agent-runner-src', rel);
  }
  if (norm.startsWith('container/skills/')) {
    const rel = norm.slice('container/skills/'.length);
    return path.join(DATA_DIR, 'v2-sessions', originatingGroupId, '.claude-shared', 'skills', rel);
  }
  // Non-runner/skills paths are already the repo path — should never be
  // passed here since we filter first.
  return path.join(PROJECT_ROOT, norm);
}
