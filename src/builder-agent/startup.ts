/**
 * Builder-agent startup sweep.
 *
 * Runs once on host startup (from `src/index.ts::main()` after migrations).
 * Two jobs, one code path:
 *
 *   1. **Resume in-flight deadmans.** Any `pending_swaps` row in
 *      `awaiting_confirmation` either (a) belongs to a host-level swap
 *      whose host just restarted as the expected part of the dance, or
 *      (b) belongs to a group-level swap whose host crashed mid-dance.
 *      In either case we look at `deadman_expires_at`: if the deadline is
 *      in the past, auto-rollback; if in the future, rehydrate the timer
 *      and (for case a) send the handshake card now.
 *
 *   2. **Delete orphan worktrees.** Any `.worktrees/dev-*` directory whose
 *      corresponding `pending_swaps` row is in a terminal state
 *      (`finalized`, `rolled_back`, `rejected`) or missing altogether.
 */
import fs from 'fs';
import path from 'path';

import {
  getAwaitingConfirmationSwaps,
  getPendingSwap,
} from '../db/pending-swaps.js';
import { log } from '../log.js';
import { resumeDeadman } from './deadman.js';
import { removeDevWorktree } from './worktree.js';

const WORKTREES_DIR = path.join(process.cwd(), '.worktrees');

export async function runBuilderAgentStartupSweep(): Promise<void> {
  await resumeInFlightSwaps();
  cleanupOrphanWorktrees();
}

async function resumeInFlightSwaps(): Promise<void> {
  const pending = getAwaitingConfirmationSwaps();
  if (pending.length === 0) return;

  log.info('Resuming in-flight builder-agent swaps', { count: pending.length });
  for (const swap of pending) {
    try {
      await resumeDeadman(swap);
    } catch (err) {
      log.error('resumeDeadman threw', { requestId: swap.request_id, err });
    }
  }
}

function cleanupOrphanWorktrees(): void {
  if (!fs.existsSync(WORKTREES_DIR)) return;

  const entries = fs.readdirSync(WORKTREES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('dev-')) continue;
    const requestId = entry.name.slice('dev-'.length);
    const swap = getPendingSwap(requestId);

    // Orphaned if: no row, or row in a terminal state.
    const terminal =
      !swap ||
      swap.status === 'finalized' ||
      swap.status === 'rolled_back' ||
      swap.status === 'rejected';

    if (terminal) {
      log.info('Cleaning up orphan worktree', { requestId, status: swap?.status ?? 'missing' });
      try {
        removeDevWorktree(requestId);
      } catch (err) {
        log.warn('Failed to remove orphan worktree', { requestId, err });
      }
    }
  }
}
