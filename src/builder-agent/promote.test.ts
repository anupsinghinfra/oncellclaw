import path from 'path';

import { describe, expect, it } from 'vitest';

import { sourceForTemplate, swapTouchedRunnerOrSkills } from './promote.js';
import { targetRepoRelPath } from './swap.js';
import { DATA_DIR } from '../config.js';
import type { PendingSwap } from '../types.js';

function makeSwap(files: Array<{ path: string; classification: 'group' | 'host' }>): PendingSwap {
  return {
    request_id: 'req-1',
    dev_agent_id: 'ag-dev',
    originating_group_id: 'ag-abc',
    dev_branch: 'dev/req-1',
    commit_sha: 'sha',
    classification: 'group',
    status: 'finalized',
    summary_json: JSON.stringify({
      overallSummary: 'test',
      perFileSummaries: {},
      classifiedFiles: files,
      touchesMigrations: false,
    }),
    pre_swap_sha: null,
    db_snapshot_path: null,
    deadman_started_at: null,
    deadman_expires_at: null,
    handshake_state: null,
    created_at: '2026-04-15T00:00:00Z',
  };
}

describe('swapTouchedRunnerOrSkills', () => {
  it('is false when only groups/ files are touched', () => {
    const swap = makeSwap([{ path: 'groups/main/CLAUDE.md', classification: 'group' }]);
    expect(swapTouchedRunnerOrSkills(swap)).toBe(false);
  });

  it('is true when container/agent-runner/src is touched', () => {
    const swap = makeSwap([
      { path: 'container/agent-runner/src/poll-loop.ts', classification: 'group' },
    ]);
    expect(swapTouchedRunnerOrSkills(swap)).toBe(true);
  });

  it('is true when container/skills is touched', () => {
    const swap = makeSwap([{ path: 'container/skills/browser/SKILL.md', classification: 'group' }]);
    expect(swapTouchedRunnerOrSkills(swap)).toBe(true);
  });

  it('is true when runner/skills AND host paths are mixed (combined diff)', () => {
    const swap = makeSwap([
      { path: 'src/delivery.ts', classification: 'host' },
      { path: 'container/agent-runner/src/poll-loop.ts', classification: 'group' },
    ]);
    expect(swapTouchedRunnerOrSkills(swap)).toBe(true);
  });

  it('is false when only host paths are touched', () => {
    const swap = makeSwap([{ path: 'src/delivery.ts', classification: 'host' }]);
    expect(swapTouchedRunnerOrSkills(swap)).toBe(false);
  });

  it('is false for an empty diff', () => {
    const swap = makeSwap([]);
    expect(swapTouchedRunnerOrSkills(swap)).toBe(false);
  });
});

describe('sourceForTemplate', () => {
  it('maps runner template paths to the per-group private dir (absolute)', () => {
    const src = sourceForTemplate('container/agent-runner/src/index.ts', 'ag-abc');
    expect(src).toBe(path.join(DATA_DIR, 'v2-sessions', 'ag-abc', 'agent-runner-src', 'index.ts'));
  });

  it('maps nested runner paths correctly', () => {
    const src = sourceForTemplate('container/agent-runner/src/mcp-tools/agents.ts', 'ag-abc');
    expect(src).toBe(
      path.join(DATA_DIR, 'v2-sessions', 'ag-abc', 'agent-runner-src', 'mcp-tools', 'agents.ts'),
    );
  });

  it('maps skills template paths to the per-group skills dir', () => {
    const src = sourceForTemplate('container/skills/browser/SKILL.md', 'ag-abc');
    expect(src).toBe(
      path.join(DATA_DIR, 'v2-sessions', 'ag-abc', '.claude-shared', 'skills', 'browser', 'SKILL.md'),
    );
  });
});

describe('promote source mapping matches classifier target mapping', () => {
  // Invariant: for every runner/skills template path, the classifier's
  // target (for applying the swap) and promote's source (for reading back
  // from the committed per-group state) must be the same repo-relative
  // path. Both transforms should agree or rollback/promote will hit
  // different files.
  it('runner path round-trips through both transforms', () => {
    const templatePath = 'container/agent-runner/src/index.ts';
    const viaClassifier = targetRepoRelPath(templatePath, 'ag-abc');
    // sourceForTemplate returns absolute; strip project root to compare.
    const viaPromote = path.relative(process.cwd(), sourceForTemplate(templatePath, 'ag-abc'));
    expect(viaPromote).toBe(viaClassifier);
  });

  it('skills path round-trips through both transforms', () => {
    const templatePath = 'container/skills/browser/SKILL.md';
    const viaClassifier = targetRepoRelPath(templatePath, 'ag-abc');
    const viaPromote = path.relative(process.cwd(), sourceForTemplate(templatePath, 'ag-abc'));
    expect(viaPromote).toBe(viaClassifier);
  });
});
