import type { PendingSwap, SwapHandshakeState, SwapStatus } from '../types.js';
import { getDb } from './connection.js';

export function createPendingSwap(swap: PendingSwap): void {
  getDb()
    .prepare(
      `INSERT INTO pending_swaps (
         request_id, dev_agent_id, originating_group_id, dev_branch, commit_sha,
         classification, status, summary_json, pre_swap_sha, db_snapshot_path,
         deadman_started_at, deadman_expires_at, handshake_state, created_at
       ) VALUES (
         @request_id, @dev_agent_id, @originating_group_id, @dev_branch, @commit_sha,
         @classification, @status, @summary_json, @pre_swap_sha, @db_snapshot_path,
         @deadman_started_at, @deadman_expires_at, @handshake_state, @created_at
       )`,
    )
    .run(swap);
}

export function getPendingSwap(requestId: string): PendingSwap | undefined {
  return getDb().prepare('SELECT * FROM pending_swaps WHERE request_id = ?').get(requestId) as PendingSwap | undefined;
}

/**
 * Returns the in-flight swap for an originating group, if any. "In-flight"
 * means not in a terminal status (finalized / rolled_back / rejected).
 * Used to enforce one-swap-per-originating-group serialization.
 */
export function getInFlightSwapForGroup(originatingGroupId: string): PendingSwap | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM pending_swaps
       WHERE originating_group_id = ?
         AND status IN ('pending_approval', 'awaiting_confirmation')
       LIMIT 1`,
    )
    .get(originatingGroupId) as PendingSwap | undefined;
}

/**
 * Returns the in-flight swap for a dev-agent group. Used by the container
 * runner to decide whether to mount the worktree on the dev agent's container.
 */
export function getSwapForDevAgent(devAgentId: string): PendingSwap | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM pending_swaps
       WHERE dev_agent_id = ?
         AND status IN ('pending_approval', 'awaiting_confirmation')
       LIMIT 1`,
    )
    .get(devAgentId) as PendingSwap | undefined;
}

/**
 * All swaps currently in `awaiting_confirmation` — used by the startup sweep
 * to resume deadmans after a host restart (expected for host-level swaps,
 * unexpected for group-level crashes).
 */
export function getAwaitingConfirmationSwaps(): PendingSwap[] {
  return getDb().prepare(`SELECT * FROM pending_swaps WHERE status = 'awaiting_confirmation'`).all() as PendingSwap[];
}

/** All terminal-status swaps — used by the startup worktree-orphan sweep. */
export function getTerminalSwaps(): PendingSwap[] {
  return getDb()
    .prepare(`SELECT * FROM pending_swaps WHERE status IN ('finalized', 'rolled_back', 'rejected')`)
    .all() as PendingSwap[];
}

export function updatePendingSwapStatus(requestId: string, status: SwapStatus): void {
  getDb().prepare('UPDATE pending_swaps SET status = ? WHERE request_id = ?').run(status, requestId);
}

export function setSwapPreSwapState(requestId: string, preSwapSha: string, dbSnapshotPath: string): void {
  getDb()
    .prepare(
      `UPDATE pending_swaps
         SET pre_swap_sha = ?, db_snapshot_path = ?
       WHERE request_id = ?`,
    )
    .run(preSwapSha, dbSnapshotPath, requestId);
}

export function startSwapDeadman(
  requestId: string,
  startedAt: string,
  expiresAt: string,
  handshakeState: SwapHandshakeState,
): void {
  getDb()
    .prepare(
      `UPDATE pending_swaps
         SET status = 'awaiting_confirmation',
             deadman_started_at = ?,
             deadman_expires_at = ?,
             handshake_state = ?
       WHERE request_id = ?`,
    )
    .run(startedAt, expiresAt, handshakeState, requestId);
}

export function extendSwapDeadman(requestId: string, expiresAt: string): void {
  getDb().prepare('UPDATE pending_swaps SET deadman_expires_at = ? WHERE request_id = ?').run(expiresAt, requestId);
}

export function setSwapHandshakeState(requestId: string, state: SwapHandshakeState): void {
  getDb().prepare('UPDATE pending_swaps SET handshake_state = ? WHERE request_id = ?').run(state, requestId);
}

export function deletePendingSwap(requestId: string): void {
  getDb().prepare('DELETE FROM pending_swaps WHERE request_id = ?').run(requestId);
}

/**
 * Reset a swap back to `pending_approval` after a post-approval failure
 * (apply / commit / build error). Clears the in-progress fields so a
 * subsequent `request_swap` call from the dev agent starts clean. Leaves
 * the dev_agent_id + originating_group_id + dev_branch intact so the dev
 * agent can fix the issue in its worktree and retry without having to
 * spin up a fresh dev agent.
 */
export function resetSwapForRetry(requestId: string): void {
  getDb()
    .prepare(
      `UPDATE pending_swaps
         SET status = 'pending_approval',
             commit_sha = '',
             pre_swap_sha = NULL,
             db_snapshot_path = NULL,
             deadman_started_at = NULL,
             deadman_expires_at = NULL,
             handshake_state = NULL
       WHERE request_id = ?`,
    )
    .run(requestId);
}
