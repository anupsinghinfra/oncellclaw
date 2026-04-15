/**
 * Builder-agent deadman dance.
 *
 * After a swap is applied and the originating container (or host) restarts,
 * we give the user a short window to confirm the new version is working.
 * Mechanism: send a two-button card (Confirm/Rollback) and start an
 * in-memory timer backed by `pending_swaps.deadman_expires_at`. The DB row
 * is source of truth so the timer survives host restart via the startup
 * sweep in `startup.ts`.
 *
 * Two-message handshake:
 *   1. Host → user: card "I'm back with the new version. Reply confirm to keep it."
 *   2. User → agent: click "Confirm" (or "Rollback") → card clicks route through
 *      `handleQuestionResponse` in index.ts, which delegates to
 *      `handleSwapConfirmationResponse` here.
 *
 * Timer extension: when we successfully deliver step 1, we bump
 * `deadman_expires_at` to +2 minutes from now (so slow channel reconnects
 * don't trigger false rollback once we know outbound works). Hard cap:
 * 10 minutes absolute maximum from initial start.
 */
import { createPendingApproval, deletePendingApproval } from '../db/sessions.js';
import { findSessionByAgentGroup } from '../db/sessions.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import {
  extendSwapDeadman,
  getAwaitingConfirmationSwaps,
  getPendingSwap,
  setSwapHandshakeState,
  startSwapDeadman,
  updatePendingSwapStatus,
} from '../db/pending-swaps.js';
import { log } from '../log.js';
import type { PendingSwap } from '../types.js';
import { maybeSendPromotePrompt } from './promote.js';
import { removeDevWorktree } from './worktree.js';
import {
  isHostLevelSwap,
  parseSwapSummary,
  restoreDbFromSnapshot,
  rollbackSwapFiles,
} from './swap.js';

const DEADMAN_INITIAL_MS = 2 * 60 * 1000;
const DEADMAN_HARD_CAP_MS = 10 * 60 * 1000;

/** In-memory timers keyed by request_id. Rehydrated by the startup sweep. */
const activeTimers = new Map<string, NodeJS.Timeout>();

/** Abstract channel-delivery surface so deadman can run without importing delivery.ts. */
export interface DeadmanDelivery {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
  ): Promise<string | undefined>;
}

let deliveryRef: DeadmanDelivery | null = null;

export function setDeadmanDelivery(adapter: DeadmanDelivery): void {
  deliveryRef = adapter;
}

/**
 * Start the deadman for a freshly-applied swap. Called either directly
 * after a group-level swap (host stays up) or by the startup sweep for a
 * host-level swap (host just restarted).
 */
export async function startDeadman(requestId: string): Promise<void> {
  const swap = getPendingSwap(requestId);
  if (!swap) {
    log.warn('startDeadman: swap not found', { requestId });
    return;
  }

  const now = Date.now();
  const hardCap = swap.deadman_started_at
    ? new Date(swap.deadman_started_at).getTime() + DEADMAN_HARD_CAP_MS
    : now + DEADMAN_HARD_CAP_MS;
  const expiresAtMs = Math.min(now + DEADMAN_INITIAL_MS, hardCap);
  const startedAtIso = swap.deadman_started_at ?? new Date(now).toISOString();
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  startSwapDeadman(requestId, startedAtIso, expiresAtIso, 'pending_restart');

  const delivered = await sendHandshakeCard(swap);
  if (delivered) {
    setSwapHandshakeState(requestId, 'message1_sent');
    // Extend timer by a fresh +2 min from NOW, capped by hard cap.
    const extended = Math.min(Date.now() + DEADMAN_INITIAL_MS, hardCap);
    extendSwapDeadman(requestId, new Date(extended).toISOString());
  }
  scheduleTimer(requestId, Math.max(100, (delivered ? Date.now() + DEADMAN_INITIAL_MS : expiresAtMs) - Date.now()));
}

/** Resume a deadman from persisted state after a host restart. */
export async function resumeDeadman(swap: PendingSwap): Promise<void> {
  if (!swap.deadman_expires_at) {
    log.warn('resumeDeadman: no deadman_expires_at, rolling back', { requestId: swap.request_id });
    await executeRollback(swap.request_id, 'startup: corrupt deadman state');
    return;
  }
  const remainingMs = new Date(swap.deadman_expires_at).getTime() - Date.now();
  if (remainingMs <= 0) {
    log.info('Deadman already expired at startup; rolling back', { requestId: swap.request_id });
    await executeRollback(swap.request_id, 'startup: deadman expired');
    return;
  }

  log.info('Resuming deadman after host restart', {
    requestId: swap.request_id,
    remainingMs,
    handshakeState: swap.handshake_state,
  });

  // If we're here after a host-level swap restart, handshake_state is still
  // 'pending_restart' — we haven't sent message 1 yet because the host was
  // in the middle of restarting. Send it now.
  if (swap.handshake_state === 'pending_restart') {
    const delivered = await sendHandshakeCard(swap);
    if (delivered) setSwapHandshakeState(swap.request_id, 'message1_sent');
  }

  scheduleTimer(swap.request_id, remainingMs);
}

function scheduleTimer(requestId: string, ms: number): void {
  const existing = activeTimers.get(requestId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    activeTimers.delete(requestId);
    void executeRollback(requestId, 'deadman timeout');
  }, ms);
  activeTimers.set(requestId, handle);
}

/**
 * Send a Confirm/Rollback card to the user on the originating session's
 * messaging group. Returns true on successful delivery; false means the
 * channel isn't reachable and the deadman will fall through to timeout
 * (safe default: rollback if we can't even talk to the user).
 */
async function sendHandshakeCard(swap: PendingSwap): Promise<boolean> {
  if (!deliveryRef) {
    log.warn('sendHandshakeCard: no delivery adapter set', { requestId: swap.request_id });
    return false;
  }

  // Find the originating agent's most recent active session so we know
  // which messaging group to send the card to.
  const session = findSessionByAgentGroup(swap.originating_group_id);
  if (!session || !session.messaging_group_id) {
    log.warn('sendHandshakeCard: no originating session with messaging group', {
      requestId: swap.request_id,
    });
    return false;
  }
  const mg = getMessagingGroup(session.messaging_group_id);
  if (!mg) {
    log.warn('sendHandshakeCard: messaging group not found', { requestId: swap.request_id });
    return false;
  }

  // Create a pending_approval row so the button click routes back to
  // handleSwapConfirmationResponse via the existing handleApprovalResponse
  // dispatch in index.ts.
  const approvalId = `swapconf-${swap.request_id}`;
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: swap.request_id,
    action: 'swap_confirmation',
    payload: JSON.stringify({ swapRequestId: swap.request_id }),
    created_at: new Date().toISOString(),
    title: 'Confirm code change',
    options_json: JSON.stringify([
      { label: 'Confirm', selectedLabel: '✅ Confirmed', value: 'confirm' },
      { label: 'Rollback', selectedLabel: '↩️ Rolled back', value: 'rollback' },
    ]),
  });

  const summary = parseSwapSummary(swap);
  const body =
    `I'm back with the new version of my code.\n\n` +
    `**What changed:** ${summary.overallSummary || '(no summary)'}\n\n` +
    `Reply **Confirm** within 2 minutes to keep the new version, or **Rollback** to revert.`;

  try {
    await deliveryRef.deliver(
      mg.channel_type,
      mg.platform_id,
      session.thread_id,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title: 'Confirm code change',
        question: body,
        options: [
          { label: 'Confirm', selectedLabel: '✅ Confirmed', value: 'confirm' },
          { label: 'Rollback', selectedLabel: '↩️ Rolled back', value: 'rollback' },
        ],
      }),
    );
    log.info('Deadman handshake card delivered', { requestId: swap.request_id, approvalId });
    return true;
  } catch (err) {
    log.error('Deadman handshake card delivery failed', { requestId: swap.request_id, err });
    return false;
  }
}

/**
 * Called by `handleApprovalResponse` in index.ts when the user clicks a
 * button on the deadman card. `confirm` finalizes; anything else rolls back.
 */
export async function handleSwapConfirmationResponse(
  approvalId: string,
  swapRequestId: string,
  selectedOption: string,
): Promise<void> {
  const swap = getPendingSwap(swapRequestId);
  if (!swap) {
    log.warn('handleSwapConfirmationResponse: swap not found', { swapRequestId });
    deletePendingApproval(approvalId);
    return;
  }

  const timer = activeTimers.get(swapRequestId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(swapRequestId);
  }

  if (selectedOption === 'confirm') {
    await finalizeSwap(swap);
  } else {
    await executeRollback(swapRequestId, 'user clicked rollback');
  }

  deletePendingApproval(approvalId);
}

async function finalizeSwap(swap: PendingSwap): Promise<void> {
  updatePendingSwapStatus(swap.request_id, 'finalized');
  try {
    removeDevWorktree(swap.request_id);
  } catch (err) {
    log.warn('Failed to remove worktree during finalize', { requestId: swap.request_id, err });
  }
  log.info('Swap finalized', { requestId: swap.request_id });

  // Fire the promote-to-template prompt if the diff touched runner/skills
  // paths. No-op if it didn't, and failures are swallowed so finalize
  // always reports success to the user.
  try {
    await maybeSendPromotePrompt(swap);
  } catch (err) {
    log.error('maybeSendPromotePrompt threw', { requestId: swap.request_id, err });
  }
}

async function executeRollback(requestId: string, reason: string): Promise<void> {
  const swap = getPendingSwap(requestId);
  if (!swap) return;

  log.info('Executing swap rollback', { requestId, reason });

  try {
    rollbackSwapFiles(swap);
  } catch (err) {
    log.error('rollbackSwapFiles threw', { requestId, err });
  }

  // For host-level swaps, the central DB may have been mutated by the new
  // code since the swap. Restore from snapshot and then exit so the
  // supervisor respawns the host on the old code. For group-level swaps,
  // just restart the originating agent's container.
  if (isHostLevelSwap(swap)) {
    try {
      restoreDbFromSnapshot(swap);
    } catch (err) {
      log.error('restoreDbFromSnapshot failed during rollback', { requestId, err });
    }
  }

  updatePendingSwapStatus(requestId, 'rolled_back');

  try {
    removeDevWorktree(requestId);
  } catch {
    /* best-effort */
  }

  if (isHostLevelSwap(swap)) {
    log.warn('Host-level rollback triggering process exit for supervisor respawn', {
      requestId,
    });
    // Give log sinks a moment to flush.
    setTimeout(() => process.exit(0), 250);
  }
  // For group-level, the next message to the originating agent will spawn
  // a fresh container that picks up the rolled-back files.
}
