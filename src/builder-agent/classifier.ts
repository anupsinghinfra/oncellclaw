/**
 * Diff classification for builder-agent swaps.
 *
 * Every changed file is classified as:
 *   - group: lands in the originating group's private per-group dir or own folder
 *   - host:  lands in host code / repo template / other groups (requires owner + typed confirmation)
 *
 * The overall swap classification:
 *   - 'group':     all changes are group-level
 *   - 'host':      all changes are host-level, none touch runner/skills
 *   - 'combined':  host-level AND touches container/agent-runner or container/skills
 *                  (triggers the cross-group safety warning on the approval card)
 *
 * Classification is purely about APPROVAL ROUTING and SWAP TARGETS, not about
 * what the dev agent was allowed to write. The dev agent has full worktree
 * write access; classification happens at `request_swap` time.
 *
 * Swap-target mapping: given a changed path in the worktree, where does it
 * land on disk when the swap is applied? Group-level files go to the
 * originating group's private dir; host-level files go to the repo paths.
 */

import path from 'path';

import type { SwapClassification } from '../types.js';

export type FileClassification = 'group' | 'host';

export interface ClassifiedFile {
  /** Path relative to the worktree root (same form `git diff --name-only` returns). */
  path: string;
  classification: FileClassification;
  /**
   * Absolute on-disk destination where this file lands when the swap is
   * applied. Computed relative to `projectRoot` (the main repo) and, for
   * group-level paths under `container/agent-runner/src/**` or
   * `container/skills/**`, redirected into the originating group's private
   * per-group dirs under `data/v2-sessions/<id>/`.
   */
  targetAbsPath: string;
}

export interface ClassifiedDiff {
  files: ClassifiedFile[];
  overall: SwapClassification;
  /** Subset of `files` with classification === 'host'. */
  hostPaths: ClassifiedFile[];
  /** Subset of `files` that touch runner or skills code (regardless of classification). */
  runnerOrSkillsPaths: ClassifiedFile[];
  /**
   * True iff any file under `src/db/migrations/**` is in the diff — drives
   * the rollback-may-be-lossy warning on the approval card.
   */
  touchesMigrations: boolean;
}

export interface ClassifyOptions {
  /** Absolute path to the main repo root (used for host-target mapping). */
  projectRoot: string;
  /** Absolute path to the data dir (typically `<projectRoot>/data`). */
  dataDir: string;
  /** Agent-group ID whose private dirs are the targets for group-level swaps. */
  originatingGroupId: string;
  /**
   * Folder name (not ID) for the originating group, used to identify the
   * one allowed `groups/<folder>/**` path. Other groups are host-level.
   */
  originatingGroupFolder: string;
}

/**
 * Classify a single path. Used by `classifyDiff`; exported for unit tests.
 * Returns null for paths that must never be written to (excluded mount paths),
 * e.g. `.env`, `data/` (outside the carve-outs), `store/`. Callers should treat
 * null as a reject-with-error signal.
 */
export function classifyPath(
  relPath: string,
  opts: ClassifyOptions,
): { classification: FileClassification; target: string } | null {
  const norm = relPath.replace(/\\/g, '/');

  if (norm === '' || norm.startsWith('..') || path.isAbsolute(norm)) return null;
  if (norm === '.env' || norm.startsWith('.env.')) return null;
  if (norm === 'store' || norm.startsWith('store/')) return null;

  // data/ is host-unreachable EXCEPT for the per-group carve-outs which are
  // tracked in git by design. The builder-agent flow never writes directly
  // to those paths via the worktree (the worktree reflects the overlaid
  // template path under container/agent-runner/src/ etc.), so any diff entry
  // under data/** is a reject.
  if (norm === 'data' || norm.startsWith('data/')) return null;

  // ── group-level ────────────────────────────────────────────────
  // container/agent-runner/src/**  →  data/v2-sessions/<id>/agent-runner-src/**
  const runnerPrefix = 'container/agent-runner/src/';
  if (norm.startsWith(runnerPrefix)) {
    const rel = norm.slice(runnerPrefix.length);
    return {
      classification: 'group',
      target: path.join(
        opts.dataDir,
        'v2-sessions',
        opts.originatingGroupId,
        'agent-runner-src',
        rel,
      ),
    };
  }

  // container/skills/**  →  data/v2-sessions/<id>/.claude-shared/skills/**
  const skillsPrefix = 'container/skills/';
  if (norm.startsWith(skillsPrefix)) {
    const rel = norm.slice(skillsPrefix.length);
    return {
      classification: 'group',
      target: path.join(
        opts.dataDir,
        'v2-sessions',
        opts.originatingGroupId,
        '.claude-shared',
        'skills',
        rel,
      ),
    };
  }

  // groups/<originating-folder>/**  →  groups/<originating-folder>/** (same path)
  const originatingPrefix = `groups/${opts.originatingGroupFolder}/`;
  if (norm.startsWith(originatingPrefix)) {
    return {
      classification: 'group',
      target: path.join(opts.projectRoot, norm),
    };
  }

  // ── host-level ─────────────────────────────────────────────────
  // Everything else lands at its repo path. groups/<other>/** is host-level
  // because touching another group's data requires owner consent.
  return {
    classification: 'host',
    target: path.join(opts.projectRoot, norm),
  };
}

/** True iff a classified file's worktree path is under runner or skills template. */
export function isRunnerOrSkillsPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return (
    norm.startsWith('container/agent-runner/src/') ||
    norm.startsWith('container/skills/')
  );
}

/** True iff a changed path is a schema migration. */
export function isMigrationPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return norm.startsWith('src/db/migrations/');
}

/**
 * Classify every changed path. Throws if any path is unreachable
 * (excluded mount paths) — the dev agent should not be able to produce such
 * a diff because the worktree filesystem excludes those paths.
 */
export function classifyDiff(changedPaths: string[], opts: ClassifyOptions): ClassifiedDiff {
  const files: ClassifiedFile[] = [];
  for (const p of changedPaths) {
    const result = classifyPath(p, opts);
    if (!result) {
      throw new Error(
        `builder-agent: diff contains unreachable or excluded path: ${p}`,
      );
    }
    files.push({
      path: p,
      classification: result.classification,
      targetAbsPath: result.target,
    });
  }

  const hostPaths = files.filter((f) => f.classification === 'host');
  const runnerOrSkillsPaths = files.filter((f) => isRunnerOrSkillsPath(f.path));
  const touchesMigrations = files.some((f) => isMigrationPath(f.path));

  let overall: SwapClassification;
  if (hostPaths.length === 0) {
    overall = 'group';
  } else if (runnerOrSkillsPaths.length > 0) {
    overall = 'combined';
  } else {
    overall = 'host';
  }

  return { files, overall, hostPaths, runnerOrSkillsPaths, touchesMigrations };
}
