/**
 * Approval card routing for builder-agent swap requests.
 *
 * Uses `pending_approvals` directly (not `onecli-approvals.ts` — swap
 * approvals are NOT credential operations). Two approval actions live
 * here:
 *
 *   - `swap_request`      — posted after the dev agent calls
 *                           `request_swap`. Routed to group admin for
 *                           group-level diffs, owner-only for host-level
 *                           or combined. Buttons: Approve / Reject.
 *   - `swap_confirmation` — the deadman handshake card. Routed back to
 *                           the originating user's DM. Handled in
 *                           `deadman.ts`.
 *
 * Host-level approvals ideally require typed confirmation to prevent
 * fat-finger approvals on mobile, but the chat-SDK bridge currently only
 * exposes button-option UI. For v1 we use a three-option card
 * (Approve / Reject / Cancel) with a prominent DANGER warning in the body
 * so the approver has to pick the dangerous option among siblings.
 * Upgrading to a true typed-confirmation flow is a follow-up when the
 * chat-SDK bridge gains a free-text question primitive.
 */
import { execFileSync } from 'child_process';

import { pickApprovalDelivery, pickApprover } from '../access.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getOwners } from '../db/user-roles.js';
import { createPendingApproval } from '../db/sessions.js';
import { getPendingSwap, updatePendingSwapStatus } from '../db/pending-swaps.js';
import { log } from '../log.js';
import type { PendingSwap, Session } from '../types.js';
import { parseSwapSummary } from './swap.js';
import { worktreePathFor } from './worktree.js';

export interface SwapApprovalDelivery {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
  ): Promise<string | undefined>;
}

let deliveryRef: SwapApprovalDelivery | null = null;

export function setSwapApprovalDelivery(adapter: SwapApprovalDelivery): void {
  deliveryRef = adapter;
}

/**
 * Post an approval card for a classified swap. Called at the end of
 * `handleRequestSwap` once the classifier has run.
 */
export async function sendSwapApprovalCard(
  swap: PendingSwap,
  originatingSession: Session,
  notifyDevAgent: (text: string) => void,
): Promise<void> {
  if (!deliveryRef) {
    log.error('sendSwapApprovalCard: no delivery adapter set', { requestId: swap.request_id });
    notifyDevAgent('Swap approval card could not be delivered: host delivery adapter missing.');
    return;
  }

  const isHostLevel = swap.classification === 'host' || swap.classification === 'combined';

  // Host-level swaps target the owner only. Group-level uses the normal
  // approver ladder (scoped admin → global admin → owner).
  const approvers = isHostLevel
    ? getOwners().map((r) => r.user_id)
    : pickApprover(swap.originating_group_id);

  if (approvers.length === 0) {
    notifyDevAgent(
      isHostLevel
        ? 'Code change rejected: no owner configured to approve host-level changes.'
        : 'Code change rejected: no approver configured for this agent group.',
    );
    updatePendingSwapStatus(swap.request_id, 'rejected');
    return;
  }

  // Origin channel kind drives tie-break preference (same as existing
  // install_packages / request_rebuild approvals).
  const originChannelType = originatingSession.messaging_group_id
    ? (await import('../db/messaging-groups.js')).getMessagingGroup(originatingSession.messaging_group_id)?.channel_type ?? ''
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    notifyDevAgent('Code change rejected: no DM channel found for any eligible approver.');
    updatePendingSwapStatus(swap.request_id, 'rejected');
    return;
  }

  const approvalId = `swapreq-${swap.request_id}`;
  const originatingGroup = getAgentGroup(swap.originating_group_id);
  const originatingName = originatingGroup?.name ?? swap.originating_group_id;
  const summary = parseSwapSummary(swap);

  // Unified multi-message review flow for BOTH group-level and host-level
  // swaps. Host-level just gets bigger warning emojis + cross-group
  // safety callouts in the intro. Group-level is the same structure
  // without the danger banner.
  await sendSwapReviewMessages(
    swap,
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    originatingName,
    summary,
    isHostLevel,
  );

  const bodyLines: string[] = [];
  if (isHostLevel) {
    bodyLines.push(
      '⚠️ ⚠️ ⚠️  **HOST-LEVEL CODE CHANGE.** Review the preceding messages carefully. Approving runs the new code with full credential scope across all agents in this install.',
    );
    if (summary.touchesMigrations) {
      bodyLines.push('⚠️  Diff includes schema migrations — rollback may be lossy.');
    }
    if (swap.classification === 'combined') {
      bodyLines.push(
        '⚠️  Diff also modifies per-agent runner/skills code. Those changes will apply only to the originating agent. Other existing agents will run the new host against their old runner and may break — you can request another code change from each affected agent to refresh them if needed.',
      );
    }
  } else {
    bodyLines.push('Review the preceding messages, then approve or reject.');
  }

  const options = isHostLevel
    ? [
        { label: 'Approve (DANGEROUS)', selectedLabel: '✅ Approved', value: 'approve' },
        { label: 'Cancel', selectedLabel: '❎ Cancelled', value: 'cancel' },
        { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
      ]
    : [
        { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
        { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
      ];

  createPendingApproval({
    approval_id: approvalId,
    session_id: originatingSession.id,
    request_id: swap.request_id,
    action: 'swap_request',
    payload: JSON.stringify({
      swapRequestId: swap.request_id,
      isHostLevel,
    }),
    created_at: new Date().toISOString(),
    title: isHostLevel ? 'Host-level code change' : 'Agent code change',
    options_json: JSON.stringify(options),
  });

  try {
    await deliveryRef.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title: isHostLevel ? 'Host-level code change' : 'Agent code change',
        question: bodyLines.join('\n'),
        options,
      }),
    );
    log.info('Swap approval card delivered', {
      requestId: swap.request_id,
      approvalId,
      approver: target.userId,
      classification: swap.classification,
    });
  } catch (err) {
    log.error('Swap approval card delivery failed', { requestId: swap.request_id, err });
    notifyDevAgent(
      `Code change approval card delivery failed: ${err instanceof Error ? err.message : String(err)}. The pending_swaps row stays in 'pending_approval' — an operator can retry or reject manually.`,
    );
  }
}

/** Hard caps for the multi-message review flow on host-level approvals. */
const DIFF_CHUNK_CHARS = 1800; // safe across channels (Discord, WhatsApp, Telegram, Slack)
const MAX_DIFF_CHUNKS = 5; // up to ~9 KB of diff across 5 messages

/**
 * Unified review flow for both group-level and host-level swaps: send an
 * intro, a per-file summary, and the raw `git diff` chunked into 1-to-N
 * code-block messages before the approval card. The approver reads the
 * actual diff in their DM and then clicks Approve/Reject (or Cancel for
 * host-level) on the card that follows.
 *
 * Host-level swaps get more aggressive warning emojis and a cross-group
 * safety callout in the intro; structure is otherwise identical.
 *
 * Delivery errors for any individual message are logged but don't abort
 * the approval — the card still goes out so the approver has at least
 * the summary-and-buttons minimum.
 */
async function sendSwapReviewMessages(
  swap: PendingSwap,
  channelType: string,
  platformId: string,
  originatingName: string,
  summary: ReturnType<typeof parseSwapSummary>,
  isHostLevel: boolean,
): Promise<void> {
  if (!deliveryRef) return;

  const send = async (text: string, idx: number): Promise<void> => {
    try {
      await deliveryRef!.deliver(
        channelType,
        platformId,
        null,
        'chat',
        JSON.stringify({ text, sender: 'system', senderId: 'builder-agent' }),
      );
    } catch (err) {
      log.warn('Swap review message delivery failed', {
        requestId: swap.request_id,
        idx,
        err,
      });
    }
  };

  // 1. Intro message
  const headerPrefix = isHostLevel
    ? '⚠️ ⚠️ ⚠️  **HOST-LEVEL CODE CHANGE PROPOSED**'
    : '🔧 **Code change proposed**';
  const intro =
    `${headerPrefix} by agent "${originatingName}".\n\n` +
    `**What it does:** ${summary.overallSummary || '(no summary)'}\n\n` +
    `${summary.classifiedFiles.length} file(s) will be edited. Full diff follows, then the approval card.`;
  await send(intro, 0);

  // 2. Per-file breakdown
  const fileLines: string[] = ['**Files in this code change:**'];
  for (const f of summary.classifiedFiles) {
    const perFile = summary.perFileSummaries[f.path] ?? '';
    fileLines.push(`- \`${f.path}\` (${f.classification})${perFile ? ` — ${perFile}` : ''}`);
  }
  await send(fileLines.join('\n'), 1);

  // 3. Chunked raw diff. Read the full unified diff from the reviewed
  // COMMIT — not the working tree — so no post-submission edits leak
  // into what the approver sees. Split into DIFF_CHUNK_CHARS-sized
  // messages wrapped in code fences. Truncate beyond MAX_DIFF_CHUNKS.
  const diffText = readRawDiff(swap.request_id, swap.commit_sha);
  if (!diffText) {
    await send('_(could not read diff from worktree — review the commit directly)_', 2);
    return;
  }
  const chunks = chunkDiff(diffText, DIFF_CHUNK_CHARS, MAX_DIFF_CHUNKS);
  for (let i = 0; i < chunks.length; i++) {
    const header = chunks.length > 1 ? `**Diff (${i + 1}/${chunks.length})**\n` : '**Diff**\n';
    await send(`${header}\`\`\`diff\n${chunks[i]}\n\`\`\``, 2 + i);
  }
  if (diffText.length > DIFF_CHUNK_CHARS * MAX_DIFF_CHUNKS) {
    await send(
      '_(diff truncated — remainder not shown. Review the dev branch in a terminal before approving.)_',
      2 + chunks.length,
    );
  }
}

/**
 * Read the unified diff of a specific commit against main from a dev
 * worktree. Uses the range syntax `main..<sha>` so only committed content
 * is included — not anything in the working tree that the (possibly still-
 * running) dev agent may have touched between submission and approval.
 */
function readRawDiff(requestId: string, commitSha: string): string | null {
  if (!commitSha) return null;
  try {
    const out = execFileSync('git', ['diff', `main..${commitSha}`], {
      cwd: worktreePathFor(requestId),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return out.trim();
  } catch (err) {
    log.warn('readRawDiff failed', { requestId, err });
    return null;
  }
}

/**
 * Chunk a diff into up to maxChunks pieces of ~chunkSize characters each.
 * Splits on newline boundaries when possible so diffs stay readable.
 */
function chunkDiff(diff: string, chunkSize: number, maxChunks: number): string[] {
  if (diff.length <= chunkSize) return [diff];

  const chunks: string[] = [];
  let i = 0;
  while (i < diff.length && chunks.length < maxChunks) {
    let end = Math.min(i + chunkSize, diff.length);
    // Prefer cutting at a newline boundary within the last 15% of the chunk.
    if (end < diff.length) {
      const lastNl = diff.lastIndexOf('\n', end);
      if (lastNl > i + chunkSize * 0.85) end = lastNl;
    }
    chunks.push(diff.slice(i, end));
    i = end;
  }
  return chunks;
}

/**
 * Look up a swap by a `swap_request` approval's payload. Used by
 * index.ts::handleApprovalResponse to dispatch to `executeSwapOnApproval`.
 */
export function getSwapFromApprovalPayload(payloadJson: string): PendingSwap | undefined {
  try {
    const p = JSON.parse(payloadJson) as { swapRequestId?: string };
    if (!p.swapRequestId) return undefined;
    return getPendingSwap(p.swapRequestId);
  } catch {
    return undefined;
  }
}
