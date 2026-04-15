import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from './connection.js';
import { createAgentGroup } from './agent-groups.js';
import { runMigrations } from './migrations/index.js';
import {
  createPendingSwap,
  deletePendingSwap,
  extendSwapDeadman,
  getAwaitingConfirmationSwaps,
  getInFlightSwapForGroup,
  getPendingSwap,
  getSwapForDevAgent,
  getTerminalSwaps,
  setSwapHandshakeState,
  setSwapPreSwapState,
  startSwapDeadman,
  updatePendingSwapStatus,
} from './pending-swaps.js';
import type { AgentGroup, PendingSwap } from '../types.js';

function makeAgentGroup(id: string, folder: string): AgentGroup {
  return {
    id,
    name: folder,
    folder,
    agent_provider: null,
    created_at: '2026-04-15T00:00:00Z',
  };
}

function makeSwap(overrides: Partial<PendingSwap> = {}): PendingSwap {
  return {
    request_id: 'req-1',
    dev_agent_id: 'ag-dev',
    originating_group_id: 'ag-origin',
    dev_branch: 'dev/req-1',
    commit_sha: '',
    classification: 'group',
    status: 'pending_approval',
    summary_json: JSON.stringify({ overallSummary: 'test', classifiedFiles: [] }),
    pre_swap_sha: null,
    db_snapshot_path: null,
    deadman_started_at: null,
    deadman_expires_at: null,
    handshake_state: null,
    created_at: '2026-04-15T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  // Both dev_agent_id and originating_group_id are FK to agent_groups.
  createAgentGroup(makeAgentGroup('ag-origin', 'origin-folder'));
  createAgentGroup(makeAgentGroup('ag-dev', 'dev-folder'));
});

afterEach(() => {
  closeDb();
});

describe('pending-swaps CRUD', () => {
  it('createPendingSwap then getPendingSwap round-trips all fields', () => {
    const swap = makeSwap({
      request_id: 'req-roundtrip',
      commit_sha: 'sha-xyz',
      summary_json: JSON.stringify({ overallSummary: 'round trip' }),
    });
    createPendingSwap(swap);

    const got = getPendingSwap('req-roundtrip');
    expect(got).toBeDefined();
    expect(got!.request_id).toBe('req-roundtrip');
    expect(got!.commit_sha).toBe('sha-xyz');
    expect(got!.classification).toBe('group');
    expect(got!.status).toBe('pending_approval');
    // Default status comes from schema; parsed summary survives.
    expect(JSON.parse(got!.summary_json).overallSummary).toBe('round trip');
  });

  it('getPendingSwap returns undefined for missing id', () => {
    expect(getPendingSwap('does-not-exist')).toBeUndefined();
  });

  it('deletePendingSwap removes the row', () => {
    createPendingSwap(makeSwap({ request_id: 'req-del' }));
    deletePendingSwap('req-del');
    expect(getPendingSwap('req-del')).toBeUndefined();
  });
});

describe('pending-swaps lookup by group / dev agent', () => {
  it('getInFlightSwapForGroup returns pending_approval rows', () => {
    createPendingSwap(makeSwap({ request_id: 'req-a', status: 'pending_approval' }));
    const got = getInFlightSwapForGroup('ag-origin');
    expect(got?.request_id).toBe('req-a');
  });

  it('getInFlightSwapForGroup returns awaiting_confirmation rows', () => {
    createPendingSwap(makeSwap({ request_id: 'req-b', status: 'awaiting_confirmation' }));
    const got = getInFlightSwapForGroup('ag-origin');
    expect(got?.request_id).toBe('req-b');
  });

  it('getInFlightSwapForGroup does NOT return terminal rows', () => {
    createPendingSwap(makeSwap({ request_id: 'req-c', status: 'finalized' }));
    expect(getInFlightSwapForGroup('ag-origin')).toBeUndefined();
    createPendingSwap(makeSwap({ request_id: 'req-d', status: 'rolled_back' }));
    expect(getInFlightSwapForGroup('ag-origin')).toBeUndefined();
    createPendingSwap(makeSwap({ request_id: 'req-e', status: 'rejected' }));
    expect(getInFlightSwapForGroup('ag-origin')).toBeUndefined();
  });

  it('getSwapForDevAgent returns the row where dev_agent_id matches', () => {
    createPendingSwap(makeSwap({ request_id: 'req-f' }));
    const got = getSwapForDevAgent('ag-dev');
    expect(got?.request_id).toBe('req-f');
  });

  it('getSwapForDevAgent returns undefined for unrelated dev agent', () => {
    createPendingSwap(makeSwap({ request_id: 'req-g' }));
    expect(getSwapForDevAgent('ag-unrelated')).toBeUndefined();
  });
});

describe('pending-swaps status transitions', () => {
  it('updatePendingSwapStatus transitions through the lifecycle', () => {
    createPendingSwap(makeSwap({ request_id: 'req-life' }));

    updatePendingSwapStatus('req-life', 'awaiting_confirmation');
    expect(getPendingSwap('req-life')!.status).toBe('awaiting_confirmation');

    updatePendingSwapStatus('req-life', 'finalized');
    expect(getPendingSwap('req-life')!.status).toBe('finalized');
  });

  it('setSwapPreSwapState populates pre_swap_sha + db_snapshot_path', () => {
    createPendingSwap(makeSwap({ request_id: 'req-pre' }));
    setSwapPreSwapState('req-pre', 'sha-pre', '/tmp/snap.sqlite');
    const got = getPendingSwap('req-pre')!;
    expect(got.pre_swap_sha).toBe('sha-pre');
    expect(got.db_snapshot_path).toBe('/tmp/snap.sqlite');
  });

  it('startSwapDeadman transitions to awaiting_confirmation and sets deadman fields', () => {
    createPendingSwap(makeSwap({ request_id: 'req-dead' }));
    startSwapDeadman('req-dead', '2026-04-15T01:00:00Z', '2026-04-15T01:02:00Z', 'pending_restart');
    const got = getPendingSwap('req-dead')!;
    expect(got.status).toBe('awaiting_confirmation');
    expect(got.deadman_started_at).toBe('2026-04-15T01:00:00Z');
    expect(got.deadman_expires_at).toBe('2026-04-15T01:02:00Z');
    expect(got.handshake_state).toBe('pending_restart');
  });

  it('extendSwapDeadman updates only deadman_expires_at', () => {
    createPendingSwap(makeSwap({ request_id: 'req-ext' }));
    startSwapDeadman('req-ext', '2026-04-15T01:00:00Z', '2026-04-15T01:02:00Z', 'pending_restart');
    extendSwapDeadman('req-ext', '2026-04-15T01:05:00Z');
    const got = getPendingSwap('req-ext')!;
    expect(got.deadman_expires_at).toBe('2026-04-15T01:05:00Z');
    expect(got.deadman_started_at).toBe('2026-04-15T01:00:00Z');
    expect(got.handshake_state).toBe('pending_restart');
  });

  it('setSwapHandshakeState updates only the handshake state', () => {
    createPendingSwap(makeSwap({ request_id: 'req-hs' }));
    startSwapDeadman('req-hs', '2026-04-15T01:00:00Z', '2026-04-15T01:02:00Z', 'pending_restart');
    setSwapHandshakeState('req-hs', 'message1_sent');
    expect(getPendingSwap('req-hs')!.handshake_state).toBe('message1_sent');
  });
});

describe('pending-swaps bulk lookups', () => {
  it('getAwaitingConfirmationSwaps returns only that status', () => {
    createPendingSwap(makeSwap({ request_id: 'req-pending', status: 'pending_approval' }));
    createPendingSwap(makeSwap({ request_id: 'req-await', status: 'awaiting_confirmation' }));
    createPendingSwap(makeSwap({ request_id: 'req-final', status: 'finalized' }));

    const got = getAwaitingConfirmationSwaps();
    expect(got).toHaveLength(1);
    expect(got[0].request_id).toBe('req-await');
  });

  it('getTerminalSwaps returns rows in terminal statuses', () => {
    createPendingSwap(makeSwap({ request_id: 'req-t1', status: 'finalized' }));
    createPendingSwap(makeSwap({ request_id: 'req-t2', status: 'rolled_back' }));
    createPendingSwap(makeSwap({ request_id: 'req-t3', status: 'rejected' }));
    createPendingSwap(makeSwap({ request_id: 'req-active', status: 'awaiting_confirmation' }));

    const terminal = getTerminalSwaps().map((s) => s.request_id).sort();
    expect(terminal).toEqual(['req-t1', 'req-t2', 'req-t3']);
  });
});
