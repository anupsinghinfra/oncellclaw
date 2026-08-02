/**
 * Durable scheduler wakes — next-due computation and platform registration
 * (registrar stubbed; no network anywhere).
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/oncellclaw-test-durable-wake/data',
  GROUPS_DIR: '/tmp/oncellclaw-test-durable-wake/groups',
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import {
  computeNextDueTime,
  isHostedClawPosture,
  refreshDurableWake,
  _registeredWakeAtForTesting,
  _setWakeRegistrarForTesting,
  type CellWakeRegistrar,
} from './durable-wake.js';
import type { Session } from '../../types.js';

const TEST_ROOT = '/tmp/oncellclaw-test-durable-wake';
const NOW = '2026-08-02T12:00:00.000Z';

function seedSession(agId: string, sessId: string): void {
  createAgentGroup({ id: agId, name: agId, folder: agId, agent_provider: null, created_at: NOW });
  const session: Session = {
    id: sessId,
    agent_group_id: agId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: NOW,
  };
  createSession(session);
  initSessionFolder(agId, sessId);
}

function seedScheduled(
  agId: string,
  sessId: string,
  id: string,
  processAfter: string | null,
  trigger: 0 | 1 = 1,
): void {
  writeSessionMessage(agId, sessId, {
    id,
    kind: 'task',
    timestamp: NOW,
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ text: 'scheduled' }),
    processAfter,
    trigger,
  });
}

function fakeRegistrar(): CellWakeRegistrar & { schedules: string[]; clears: number } {
  const state = { schedules: [] as string[], clears: 0 };
  return {
    ...state,
    scheduleWake: async (wakeAt: string) => {
      state.schedules.push(wakeAt);
    },
    clearWake: async () => {
      state.clears += 1;
    },
    get schedules() {
      return state.schedules;
    },
    get clears() {
      return state.clears;
    },
  };
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  _setWakeRegistrarForTesting(undefined);
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('computeNextDueTime', () => {
  it('returns the earliest FUTURE due time across sessions', () => {
    seedSession('ag-a', 'sess-a');
    seedSession('ag-b', 'sess-b');
    seedScheduled('ag-a', 'sess-a', 't-late', '2026-08-03T09:00:00.000Z');
    seedScheduled('ag-b', 'sess-b', 't-early', '2026-08-02T15:00:00.000Z');

    expect(computeNextDueTime(NOW)).toBe('2026-08-02T15:00:00.000Z');
  });

  it('ignores already-due rows, accumulate rows, and unscheduled chat', () => {
    seedSession('ag-a', 'sess-a');
    seedScheduled('ag-a', 'sess-a', 't-past', '2026-08-02T09:00:00.000Z'); // already due
    seedScheduled('ag-a', 'sess-a', 't-ctx', '2026-08-03T09:00:00.000Z', 0); // trigger=0
    seedScheduled('ag-a', 'sess-a', 'chat', null); // no schedule

    expect(computeNextDueTime(NOW)).toBeNull();
  });
});

describe('refreshDurableWake', () => {
  it('registers the next due time once, dedupes repeats, re-registers on change', async () => {
    const registrar = fakeRegistrar();
    _setWakeRegistrarForTesting(registrar);
    seedSession('ag-a', 'sess-a');
    seedScheduled('ag-a', 'sess-a', 't-1', '2099-01-01T09:00:00.000Z');

    await refreshDurableWake();
    await refreshDurableWake(); // unchanged — deduped
    expect(registrar.schedules).toEqual(['2099-01-01T09:00:00.000Z']);

    seedScheduled('ag-a', 'sess-a', 't-0', '2098-06-01T08:00:00.000Z'); // earlier task appears
    await refreshDurableWake();
    expect(registrar.schedules).toEqual(['2099-01-01T09:00:00.000Z', '2098-06-01T08:00:00.000Z']);
  });

  it('clears the wake when no scheduled tasks remain', async () => {
    const registrar = fakeRegistrar();
    _setWakeRegistrarForTesting(registrar);
    seedSession('ag-a', 'sess-a');
    seedScheduled('ag-a', 'sess-a', 't-1', '2099-01-01T09:00:00.000Z');
    await refreshDurableWake();

    // Task consumed: mark it completed, then reconcile again.
    const Database = (await import('better-sqlite3')).default;
    const { inboundDbPath } = await import('../../session-manager.js');
    const db = new Database(inboundDbPath('ag-a', 'sess-a'));
    db.prepare(`UPDATE messages_in SET status = 'completed' WHERE id = 't-1'`).run();
    db.close();

    await refreshDurableWake();
    expect(registrar.clears).toBe(1);
    expect(_registeredWakeAtForTesting()).toBe('');
  });

  it('boot re-registration: a fresh process always reconciles from the DB', async () => {
    seedSession('ag-a', 'sess-a');
    seedScheduled('ag-a', 'sess-a', 't-1', '2099-01-01T09:00:00.000Z');

    // Simulate restart: registrar state reset (same DB on disk).
    const first = fakeRegistrar();
    _setWakeRegistrarForTesting(first);
    await refreshDurableWake();
    expect(first.schedules).toEqual(['2099-01-01T09:00:00.000Z']);

    const rebooted = fakeRegistrar();
    _setWakeRegistrarForTesting(rebooted); // resets the in-memory dedup, like a new process
    await refreshDurableWake();
    expect(rebooted.schedules).toEqual(['2099-01-01T09:00:00.000Z']);
  });

  it('registration failure is retried on the next tick (dedup not advanced)', async () => {
    let failures = 1;
    const schedules: string[] = [];
    _setWakeRegistrarForTesting({
      scheduleWake: async (wakeAt: string) => {
        if (failures-- > 0) throw new Error('flaky platform');
        schedules.push(wakeAt);
      },
      clearWake: async () => {},
    });
    seedSession('ag-a', 'sess-a');
    seedScheduled('ag-a', 'sess-a', 't-1', '2099-01-01T09:00:00.000Z');

    await refreshDurableWake(); // fails, swallowed
    expect(schedules).toEqual([]);
    await refreshDurableWake(); // retried
    expect(schedules).toEqual(['2099-01-01T09:00:00.000Z']);
  });

  it('is a no-op outside the hosted-claw posture (no registrar injected)', async () => {
    // No ONCELL_CELL_ID in the test env → laptop/docker posture.
    expect(isHostedClawPosture({})).toBe(false);
    seedSession('ag-a', 'sess-a');
    seedScheduled('ag-a', 'sess-a', 't-1', '2099-01-01T09:00:00.000Z');
    await refreshDurableWake(); // must not throw, must not fetch
    expect(_registeredWakeAtForTesting()).toBeNull();
  });
});
