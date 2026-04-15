import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isHostLevelSwap,
  parseSwapSummary,
  requiresFullHostRebuild,
  targetRepoRelPath,
} from './swap.js';
import type { PendingSwap } from '../types.js';

function makeSwap(overrides: Partial<PendingSwap> = {}): PendingSwap {
  return {
    request_id: 'req-1',
    dev_agent_id: 'ag-dev-1',
    originating_group_id: 'ag-origin-1',
    dev_branch: 'dev/req-1',
    commit_sha: 'abc123',
    classification: 'group',
    status: 'pending_approval',
    summary_json: '{}',
    pre_swap_sha: null,
    db_snapshot_path: null,
    deadman_started_at: null,
    deadman_expires_at: null,
    handshake_state: null,
    created_at: '2026-04-15T00:00:00Z',
    ...overrides,
  };
}

describe('parseSwapSummary', () => {
  it('parses a well-formed summary_json', () => {
    const swap = makeSwap({
      summary_json: JSON.stringify({
        overallSummary: 'Fix the welcome message typo',
        perFileSummaries: { 'groups/main/CLAUDE.md': 'Correct typo' },
        classifiedFiles: [{ path: 'groups/main/CLAUDE.md', classification: 'group' }],
        touchesMigrations: false,
      }),
    });
    const s = parseSwapSummary(swap);
    expect(s.overallSummary).toBe('Fix the welcome message typo');
    expect(s.perFileSummaries['groups/main/CLAUDE.md']).toBe('Correct typo');
    expect(s.classifiedFiles).toHaveLength(1);
    expect(s.touchesMigrations).toBe(false);
  });

  it('fills in defaults for a missing summary_json shape', () => {
    const swap = makeSwap({ summary_json: '{}' });
    const s = parseSwapSummary(swap);
    expect(s.overallSummary).toBe('');
    expect(s.perFileSummaries).toEqual({});
    expect(s.classifiedFiles).toEqual([]);
    expect(s.touchesMigrations).toBe(false);
  });

  it('fills in defaults for a partially-populated summary_json', () => {
    const swap = makeSwap({
      summary_json: JSON.stringify({ overallSummary: 'partial', touchesMigrations: true }),
    });
    const s = parseSwapSummary(swap);
    expect(s.overallSummary).toBe('partial');
    expect(s.touchesMigrations).toBe(true);
    expect(s.classifiedFiles).toEqual([]);
  });
});

describe('isHostLevelSwap', () => {
  it('is false for group classification', () => {
    expect(isHostLevelSwap(makeSwap({ classification: 'group' }))).toBe(false);
  });
  it('is true for host classification', () => {
    expect(isHostLevelSwap(makeSwap({ classification: 'host' }))).toBe(true);
  });
  it('is true for combined classification', () => {
    expect(isHostLevelSwap(makeSwap({ classification: 'combined' }))).toBe(true);
  });
});

describe('requiresFullHostRebuild', () => {
  const root = process.cwd();
  const abs = (p: string): string => path.join(root, p);

  it('flags src/ changes', () => {
    expect(requiresFullHostRebuild([abs('src/delivery.ts')])).toBe(true);
  });
  it('flags root package.json', () => {
    expect(requiresFullHostRebuild([abs('package.json')])).toBe(true);
  });
  it('flags root Dockerfile', () => {
    expect(requiresFullHostRebuild([abs('Dockerfile')])).toBe(true);
  });
  it('flags container/Dockerfile', () => {
    expect(requiresFullHostRebuild([abs('container/Dockerfile')])).toBe(true);
  });
  it('does not flag groups/ changes', () => {
    expect(requiresFullHostRebuild([abs('groups/main/CLAUDE.md')])).toBe(false);
  });
  it('does not flag per-group runner dir changes', () => {
    expect(
      requiresFullHostRebuild([abs('data/v2-sessions/ag-1/agent-runner-src/poll-loop.ts')]),
    ).toBe(false);
  });
  it('returns true if any path requires rebuild even if others do not', () => {
    expect(
      requiresFullHostRebuild([abs('groups/main/CLAUDE.md'), abs('src/delivery.ts')]),
    ).toBe(true);
  });
});

describe('targetRepoRelPath', () => {
  it('maps runner paths to the per-group private dir', () => {
    expect(targetRepoRelPath('container/agent-runner/src/index.ts', 'ag-abc')).toBe(
      'data/v2-sessions/ag-abc/agent-runner-src/index.ts',
    );
  });

  it('maps nested runner paths correctly', () => {
    expect(
      targetRepoRelPath('container/agent-runner/src/mcp-tools/agents.ts', 'ag-abc'),
    ).toBe('data/v2-sessions/ag-abc/agent-runner-src/mcp-tools/agents.ts');
  });

  it('maps skills paths to the per-group skills dir', () => {
    expect(targetRepoRelPath('container/skills/browser/SKILL.md', 'ag-abc')).toBe(
      'data/v2-sessions/ag-abc/.claude-shared/skills/browser/SKILL.md',
    );
  });

  it('leaves host-level paths untouched', () => {
    expect(targetRepoRelPath('src/delivery.ts', 'ag-abc')).toBe('src/delivery.ts');
    expect(targetRepoRelPath('package.json', 'ag-abc')).toBe('package.json');
    expect(targetRepoRelPath('groups/main/CLAUDE.md', 'ag-abc')).toBe('groups/main/CLAUDE.md');
  });

  it('handles Windows-style separators by normalizing', () => {
    expect(
      targetRepoRelPath('container\\agent-runner\\src\\index.ts', 'ag-abc'),
    ).toBe('data/v2-sessions/ag-abc/agent-runner-src/index.ts');
  });
});
