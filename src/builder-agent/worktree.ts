/**
 * Builder-agent worktree management.
 *
 * Given an originating agent group, creates a git worktree containing a full
 * copy of the repo (via `git worktree add`), then overlays the originating
 * group's private per-group runner and skills copies over the repo template
 * so the dev agent sees the originating's actual current state, not a
 * pristine template.
 *
 * The worktree is mounted read-write into the dev agent's container at
 * /worktree, giving it write access to the whole repo *copy* (minus the
 * shadow-mounted .env and excluded data/store paths). The dev agent's own
 * runtime mounts are unchanged — it's running the live code, editing the
 * copy. Self-modification is structurally impossible.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

const PROJECT_ROOT = process.cwd();
const WORKTREES_DIR = path.join(PROJECT_ROOT, '.worktrees');

/**
 * Absolute path to a dev worktree for a given request id. Centralized so
 * every consumer (worktree.ts, swap.ts, container-runner.ts) agrees on the
 * layout.
 */
export function worktreePathFor(requestId: string): string {
  return path.join(WORKTREES_DIR, `dev-${requestId}`);
}

/** Branch name convention for dev worktrees. */
export function devBranchFor(requestId: string): string {
  return `dev/${requestId}`;
}

/**
 * Run a git command synchronously in a given cwd. Returns trimmed stdout.
 * Throws on non-zero exit. Uses execFileSync to avoid shell interpolation.
 */
function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '');
    throw new Error(`git ${args.join(' ')} failed: ${stderr || e.message || 'unknown error'}`);
  }
}

/**
 * Refuse early if the main repo is in a state git can't safely swap against
 * (mid-merge, mid-rebase, cherry-pick, bisect). We do NOT try to auto-resolve.
 * Uncommitted working-tree changes are fine because we use `git commit --only`
 * at swap time, which commits only the swap's paths.
 */
export function assertGitCleanEnoughForSwap(): void {
  const gitDir = path.join(PROJECT_ROOT, '.git');
  const weirdFiles = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_LOG'];
  for (const f of weirdFiles) {
    if (fs.existsSync(path.join(gitDir, f))) {
      throw new Error(
        `cannot start swap: git repo is in an unresolved state (${f} exists). ` +
          `resolve merge/rebase/etc in the terminal before running the builder agent.`,
      );
    }
  }
  const rebaseDir = path.join(gitDir, 'rebase-merge');
  const rebaseApply = path.join(gitDir, 'rebase-apply');
  if (fs.existsSync(rebaseDir) || fs.existsSync(rebaseApply)) {
    throw new Error(
      'cannot start swap: git repo is mid-rebase. resolve it in the terminal first.',
    );
  }
}

/**
 * Create a fresh worktree for a dev-agent request and overlay the originating
 * group's private runner + skills copies over the repo template. Returns the
 * absolute worktree path.
 *
 * Idempotency: if the worktree path already exists (from a previous request
 * or crash), it is removed first via `git worktree remove --force` so the
 * creation is clean.
 */
export function createDevWorktree(
  requestId: string,
  originatingGroupId: string,
): string {
  assertGitCleanEnoughForSwap();

  if (!fs.existsSync(WORKTREES_DIR)) {
    fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  }

  const worktreePath = worktreePathFor(requestId);
  const branch = devBranchFor(requestId);

  // If a prior worktree dir exists at this path, remove it first. `git
  // worktree remove` cleans up the worktree list; we then rm -rf as a
  // belt-and-suspenders in case the dir is orphaned but not tracked.
  if (fs.existsSync(worktreePath)) {
    try {
      git(['worktree', 'remove', '--force', worktreePath], PROJECT_ROOT);
    } catch {
      /* best-effort; dir might be orphaned */
    }
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Clean up any stale branch with the same name (unlikely but possible
  // after a crash).
  try {
    git(['branch', '-D', branch], PROJECT_ROOT);
  } catch {
    /* branch didn't exist — fine */
  }

  git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], PROJECT_ROOT);

  // Overlay: copy the originating group's private per-group dirs over the
  // worktree's repo-template paths. This makes the dev agent's view match
  // what the originating group is actually running, not the pristine
  // template.
  const sessDir = path.join(DATA_DIR, 'v2-sessions', originatingGroupId);
  overlayDir(
    path.join(sessDir, 'agent-runner-src'),
    path.join(worktreePath, 'container', 'agent-runner', 'src'),
  );
  overlayDir(
    path.join(sessDir, '.claude-shared', 'skills'),
    path.join(worktreePath, 'container', 'skills'),
  );

  // Shadow the .env with an empty placeholder so the dev agent can't read
  // credentials from a committed-but-gitignored file if one snuck into the
  // working tree somehow.
  fs.writeFileSync(path.join(worktreePath, '.env'), '# shadowed by builder-agent\n');

  log.info('Dev worktree created', {
    requestId,
    originatingGroupId,
    worktreePath,
    branch,
  });

  return worktreePath;
}

/**
 * Overlay the contents of `src` onto `dst`, overwriting any existing files.
 * Missing `src` is a silent no-op (some groups may not have customized their
 * runner/skills yet).
 */
function overlayDir(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(dst, { recursive: true });
  }
  fs.cpSync(src, dst, { recursive: true, force: true });
}

/**
 * Tear down a worktree: remove it via `git worktree remove --force`, delete
 * its branch, and rm -rf the directory as a final safety net. Idempotent.
 */
export function removeDevWorktree(requestId: string): void {
  const worktreePath = worktreePathFor(requestId);
  const branch = devBranchFor(requestId);

  try {
    git(['worktree', 'remove', '--force', worktreePath], PROJECT_ROOT);
  } catch {
    /* worktree wasn't registered — fine */
  }
  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
  try {
    git(['branch', '-D', branch], PROJECT_ROOT);
  } catch {
    /* branch didn't exist — fine */
  }

  log.info('Dev worktree removed', { requestId, worktreePath });
}

/**
 * Return the list of paths changed at a specific commit relative to main.
 * Always uses the range syntax `main..<sha>` so the result reflects what's
 * in the committed tree — NOT what's in the working-tree. This matters:
 * the dev agent may still be running when request_swap is processed, and
 * we must not pick up post-submission working-tree edits into the
 * approved diff.
 */
export function diffChangedPathsAtCommit(requestId: string, commitSha: string): string[] {
  const worktreePath = worktreePathFor(requestId);
  const out = git(['diff', '--name-only', `main..${commitSha}`], worktreePath);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Current HEAD SHA inside a dev worktree. */
export function worktreeHeadSha(requestId: string): string {
  const worktreePath = worktreePathFor(requestId);
  return git(['rev-parse', 'HEAD'], worktreePath);
}

/** Current HEAD SHA on main (captured as pre_swap_sha). */
export function mainHeadSha(): string {
  return git(['rev-parse', 'HEAD'], PROJECT_ROOT);
}
