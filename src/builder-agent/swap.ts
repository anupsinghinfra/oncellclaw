/**
 * Builder-agent swap execution.
 *
 * Called from the approval handler on "approve" for a pending swap. The
 * flow: capture pre-swap state → apply worktree files to swap targets →
 * `git commit --only` those paths to main → conditional image rebuild →
 * restart affected processes (container for group-level, host for
 * host-level) → transition pending_swaps to `awaiting_confirmation`.
 *
 * Rollback is implemented in `deadman.ts` and uses `pre_swap_sha` +
 * `git checkout <sha> -- <paths>` as the one rollback mechanism (no
 * separate per-file blob table).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import { getPendingSwap, resetSwapForRetry, setSwapPreSwapState } from '../db/pending-swaps.js';
import { log } from '../log.js';
import type { PendingSwap } from '../types.js';
import { classifyDiff, type ClassifiedFile } from './classifier.js';
import { worktreePathFor } from './worktree.js';

const PROJECT_ROOT = process.cwd();

/** Run a git command in a given cwd; throw with stderr on failure. */
function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '');
    throw new Error(`git ${args.join(' ')} failed: ${stderr || e.message || 'unknown error'}`);
  }
}

export interface SwapSummary {
  overallSummary: string;
  perFileSummaries: Record<string, string>;
  classifiedFiles: Array<{ path: string; classification: 'group' | 'host' }>;
  touchesMigrations: boolean;
}

/**
 * Decode the summary_json blob written by `handleRequestSwap`. Host-side
 * consumers (approval card rendering, swap execution) need the structured
 * form; we centralize the parse + validate here.
 */
export function parseSwapSummary(swap: PendingSwap): SwapSummary {
  const parsed = JSON.parse(swap.summary_json) as Partial<SwapSummary>;
  return {
    overallSummary: parsed.overallSummary ?? '',
    perFileSummaries: parsed.perFileSummaries ?? {},
    classifiedFiles: parsed.classifiedFiles ?? [],
    touchesMigrations: parsed.touchesMigrations ?? false,
  };
}

/** Targets change-paths that require a host-wide rebuild/restart if present. */
function isHostRebuildPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return (
    norm === 'package.json' ||
    norm === 'package-lock.json' ||
    norm === 'Dockerfile' ||
    norm.startsWith('container/Dockerfile') ||
    norm.startsWith('src/')
  );
}

/**
 * Capture pre-swap state so rollback has something to restore to:
 *   - main HEAD SHA → pending_swaps.pre_swap_sha
 *   - a full copy of the central DB → data/backups/swap-<id>.sqlite
 * SQLite is backed up via better-sqlite3's `db.backup()` which is
 * crash-safe and doesn't require stopping the app.
 */
export async function captureSwapPreState(requestId: string): Promise<void> {
  const preSwapSha = git(['rev-parse', 'HEAD'], PROJECT_ROOT);

  const backupsDir = path.join(DATA_DIR, 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
  const snapshotPath = path.join(backupsDir, `swap-${requestId}.sqlite`);
  // better-sqlite3 backup returns a Promise; await it before persisting the
  // path so a rollback that reads db_snapshot_path always finds a valid file.
  await (getDb() as unknown as { backup: (dst: string) => Promise<unknown> }).backup(snapshotPath);

  setSwapPreSwapState(requestId, preSwapSha, snapshotPath);
  log.info('Swap pre-state captured', { requestId, preSwapSha, snapshotPath });
}

/**
 * Apply the approved commit's file contents to their swap targets.
 *
 * Critical correctness property: this reads from the committed tree at
 * `pending_swaps.commit_sha`, NOT from the worktree's working files. The
 * dev agent is frozen at request_swap time (see handleRequestSwap), but
 * even if the freeze didn't exist, reading from the commit ensures we
 * apply EXACTLY what the approver reviewed — no post-submission edits
 * can sneak in by editing the working tree.
 *
 * File changes are discovered via `git diff --name-status main..<sha>`
 * inside the worktree. For A/M files we `git show <sha>:<path>` to get
 * the committed content. For D files we delete the target.
 */
export function applySwapFiles(requestId: string): string[] {
  const swap = getPendingSwap(requestId);
  if (!swap) throw new Error(`applySwapFiles: no pending_swaps row for ${requestId}`);
  if (!swap.commit_sha) {
    throw new Error(`applySwapFiles: pending_swaps row ${requestId} has no commit_sha`);
  }

  const worktreePath = worktreePathFor(requestId);
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`applySwapFiles: worktree missing at ${worktreePath}`);
  }

  const originating = getAgentGroup(swap.originating_group_id);
  if (!originating) {
    throw new Error(`applySwapFiles: originating group ${swap.originating_group_id} missing`);
  }

  // Enumerate every path that changed in the reviewed commit relative
  // to main. Pairs each path with its A/M/D status. --no-renames keeps
  // the parsing simple (a rename shows up as D+A).
  const nameStatus = git(['diff', '--name-status', '--no-renames', `main..${swap.commit_sha}`], worktreePath);

  const changes: Array<{ status: 'A' | 'M' | 'D'; path: string }> = [];
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const [statusRaw, ...pathParts] = line.split('\t');
    const s = statusRaw.charAt(0) as 'A' | 'M' | 'D';
    const p = pathParts.join('\t');
    if (s === 'A' || s === 'M' || s === 'D') {
      changes.push({ status: s, path: p });
    }
  }

  const classified = classifyDiff(
    changes.map((c) => c.path),
    {
      projectRoot: PROJECT_ROOT,
      dataDir: DATA_DIR,
      originatingGroupId: swap.originating_group_id,
      originatingGroupFolder: originating.folder,
    },
  );

  const statusByPath = new Map<string, 'A' | 'M' | 'D'>(changes.map((c) => [c.path, c.status]));

  const touchedAbs: string[] = [];
  for (const file of classified.files) {
    const status = statusByPath.get(file.path) ?? 'M';
    const dst = file.targetAbsPath;

    if (status === 'D') {
      // File was deleted in the reviewed commit — mirror by removing target.
      if (fs.existsSync(dst)) fs.rmSync(dst);
    } else {
      // A or M: read the file content at the reviewed commit via `git show`.
      // Use no encoding so we get a Buffer (safe for binary files too).
      let content: Buffer;
      try {
        content = execFileSync('git', ['show', `${swap.commit_sha}:${file.path}`], {
          cwd: worktreePath,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 20 * 1024 * 1024,
        });
      } catch (err) {
        throw new Error(
          `git show ${swap.commit_sha}:${file.path} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const dir = path.dirname(dst);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dst, content);
    }
    touchedAbs.push(dst);
  }

  log.info('Swap files applied from committed tree', {
    requestId,
    commitSha: swap.commit_sha,
    fileCount: classified.files.length,
    hostCount: classified.hostPaths.length,
    groupCount: classified.files.length - classified.hostPaths.length,
  });
  return touchedAbs;
}

/**
 * Stage and commit exactly the swap's touched paths to main, using
 * `git add <paths>` + `git commit -- <paths>`. Leaves any unrelated
 * uncommitted state in main untouched. Returns the new commit SHA.
 *
 * Path arguments to git are repo-relative so the commit is clean regardless
 * of where process.cwd() happens to resolve the absolute paths.
 */
export function commitSwap(requestId: string, touchedAbs: string[], summary: string): string {
  if (touchedAbs.length === 0) return git(['rev-parse', 'HEAD'], PROJECT_ROOT);

  const relPaths = touchedAbs.map((abs) => path.relative(PROJECT_ROOT, abs));

  // Stage everything we touched. -- disambiguates path args from refs.
  git(['add', '--', ...relPaths], PROJECT_ROOT);

  // Commit only the staged swap paths. If there are no changes (e.g. the
  // swap was a no-op because the worktree matched the current state), git
  // will exit non-zero; treat that as success and return current HEAD.
  const message = `swap ${requestId}: ${summary}`.slice(0, 500);
  try {
    git(['commit', '-m', message, '--', ...relPaths], PROJECT_ROOT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('nothing to commit') || msg.includes('no changes added')) {
      log.info('Swap commit was a no-op', { requestId });
    } else {
      throw err;
    }
  }

  const sha = git(['rev-parse', 'HEAD'], PROJECT_ROOT);
  log.info('Swap committed to main', { requestId, sha });
  return sha;
}

/**
 * Restore the files a swap touched back to their pre-swap state, then
 * record a forward-only revert commit. Used on deadman timeout and on
 * explicit rollback.
 */
export function rollbackSwapFiles(swap: PendingSwap): void {
  if (!swap.pre_swap_sha) {
    log.warn('rollbackSwapFiles called with no pre_swap_sha', { requestId: swap.request_id });
    return;
  }
  const summary = parseSwapSummary(swap);
  const relPaths = summary.classifiedFiles.map((f) => {
    // Re-compute the on-disk target for rollback. The pre_swap_sha is on main,
    // so `git checkout <sha> -- <relative-path>` always refers to repo paths.
    // Group-level targets under data/v2-sessions/... ARE repo paths thanks to
    // the gitignore carve-out, so this works uniformly.
    return targetRepoRelPath(f.path, swap.originating_group_id);
  });

  try {
    git(['checkout', swap.pre_swap_sha, '--', ...relPaths], PROJECT_ROOT);
  } catch (err) {
    log.error('git checkout during rollback failed', { requestId: swap.request_id, err });
    return;
  }

  // Record a forward-only revert commit so main's history shows what reverted.
  try {
    git(['add', '--', ...relPaths], PROJECT_ROOT);
    git(['commit', '-m', `rollback ${swap.request_id}: deadman timeout`, '--', ...relPaths], PROJECT_ROOT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!(msg.includes('nothing to commit') || msg.includes('no changes added'))) {
      log.error('Revert commit failed', { requestId: swap.request_id, err });
    }
  }
  log.info('Swap files rolled back', { requestId: swap.request_id, preSwapSha: swap.pre_swap_sha });
}

/**
 * Compute the repo-relative path where a worktree path lands on disk. This
 * mirrors classifier.ts::classifyPath but using swap metadata — needed for
 * rollback because the classifier options weren't persisted, and by the
 * promote flow which copies from the committed per-group state into the
 * repo template.
 *
 * Exported so tests can lock the mapping against the classifier's rules.
 */
export function targetRepoRelPath(worktreeRelPath: string, originatingGroupId: string): string {
  const norm = worktreeRelPath.replace(/\\/g, '/');
  if (norm.startsWith('container/agent-runner/src/')) {
    const rel = norm.slice('container/agent-runner/src/'.length);
    return path.posix.join('data', 'v2-sessions', originatingGroupId, 'agent-runner-src', rel);
  }
  if (norm.startsWith('container/skills/')) {
    const rel = norm.slice('container/skills/'.length);
    return path.posix.join('data', 'v2-sessions', originatingGroupId, '.claude-shared', 'skills', rel);
  }
  return norm;
}

/**
 * Restore the central DB from a pre-swap snapshot. better-sqlite3 doesn't
 * support live restore, so we copy the snapshot file over data/v2.db. This
 * MUST be called during the host-level swap restart window where the DB
 * connection can be reopened; doing it while the running process has the
 * DB open would corrupt in-flight transactions.
 */
export function restoreDbFromSnapshot(swap: PendingSwap): void {
  if (!swap.db_snapshot_path || !fs.existsSync(swap.db_snapshot_path)) {
    log.warn('No DB snapshot to restore', { requestId: swap.request_id });
    return;
  }
  const dbPath = path.join(DATA_DIR, 'v2.db');
  fs.copyFileSync(swap.db_snapshot_path, dbPath);
  log.info('Central DB restored from snapshot', {
    requestId: swap.request_id,
    from: swap.db_snapshot_path,
    to: dbPath,
  });
}

/**
 * Whether a swap's diff requires a host-level rebuild+restart vs just a
 * group-level container restart. The classifier's overall label is our
 * guide: `group` → group-level; `host`/`combined` → host-level.
 */
export function isHostLevelSwap(swap: PendingSwap): boolean {
  return swap.classification === 'host' || swap.classification === 'combined';
}

/**
 * Bail out of a swap execution after a failure (apply / commit / build
 * error), leaving the dev agent and its worktree intact so the dev agent
 * can fix the issue and retry via another `request_swap` call.
 *
 * Behavior:
 *   1. If we got as far as captureSwapPreState (pre_swap_sha is set),
 *      run rollbackSwapFiles to restore file contents and record a
 *      forward-only revert commit on main.
 *   2. Reset the pending_swaps row to `pending_approval` with all
 *      in-progress fields cleared — dev agent's next request_swap will
 *      find the row via getSwapForDevAgent and re-populate it.
 *   3. Caller is responsible for notifying the dev agent with the actual
 *      error message and deleting the stale pending_approval row.
 *
 * This is the RETRYABLE failure path. Explicit rejection by the approver
 * is a different flow (terminal teardown) and is handled in index.ts.
 */
export function bailSwapForRetry(requestId: string): void {
  const swap = getPendingSwap(requestId);
  if (!swap) {
    log.warn('bailSwapForRetry: swap not found', { requestId });
    return;
  }

  // Rollback on-disk file contents if we got far enough to snapshot main.
  if (swap.pre_swap_sha) {
    try {
      rollbackSwapFiles(swap);
    } catch (err) {
      log.error('rollbackSwapFiles threw during bail', { requestId, err });
    }
  }

  // Reset the row so the dev agent can retry.
  resetSwapForRetry(requestId);
  log.info('Swap bailed for retry — dev agent still alive', { requestId });
}

/**
 * Whether any of the touched repo paths require a full host-wide rebuild
 * (as opposed to just restarting the originating container). Used by the
 * caller to decide: `npm run build` in the root, rebuild base image, etc.
 */
export function requiresFullHostRebuild(touchedAbs: string[]): boolean {
  return touchedAbs.some((abs) => isHostRebuildPath(path.relative(PROJECT_ROOT, abs)));
}
