/**
 * Cell naming + orphan-cleanup scoping.
 *
 * The load-bearing property: a hosted instance boots INSIDE a `claw-*` cell,
 * in an account that may contain other users' claws. Cleanup must therefore
 * only ever touch `clawg-{ownNamespace}-…` — stopping a bare `claw-*` cell is
 * self-termination, and stopping `clawg-{other}-…` is someone else's outage.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  _resetCellNamespaceForTesting,
  _setCellClientForTesting,
  cellCustomerIdForGroup,
  cleanupOrphanCellServices,
  getCellNamespace,
  ownGroupCellPrefix,
  resolveCellNamespace,
  CELL_GROUP_PREFIX,
  LEGACY_CELL_CUSTOMER_PREFIX,
} from './cell-runtime.js';
import { closeDb, initTestDb, runMigrations, createAgentGroup } from './db/index.js';
import { log } from './log.js';
import type { CellRecord, OnCellClient } from './oncell-client.js';

/** Fake client: canned cell list, records stopService calls. */
function fakeClient(cells: CellRecord[]): { client: OnCellClient; stopped: string[] } {
  const stopped: string[] = [];
  const client = {
    listCells: async () => cells,
    stopService: async (cellId: string) => {
      stopped.push(cellId);
    },
  } as unknown as OnCellClient;
  return { client, stopped };
}

function cell(customerId: string): CellRecord {
  return { cell_id: `dev--${customerId}`, customer_id: customerId, status: 'running' };
}

afterEach(() => {
  _setCellClientForTesting(null);
  _resetCellNamespaceForTesting();
  closeDb();
  vi.restoreAllMocks();
});

describe('resolveCellNamespace', () => {
  it('defaults to the install slug when unset', () => {
    expect(resolveCellNamespace('', 'abcd1234')).toBe('abcd1234');
    expect(resolveCellNamespace('   ', 'abcd1234')).toBe('abcd1234');
  });

  it('accepts kebab-case up to 24 chars, lowercasing input', () => {
    expect(resolveCellNamespace('user-42', 'slug')).toBe('user-42');
    expect(resolveCellNamespace('User-42', 'slug')).toBe('user-42');
    expect(resolveCellNamespace('a'.repeat(24), 'slug')).toBe('a'.repeat(24));
  });

  it('rejects over-long and non-kebab values', () => {
    expect(() => resolveCellNamespace('a'.repeat(25), 'slug')).toThrow(/too long/);
    expect(() => resolveCellNamespace('has space', 'slug')).toThrow(/kebab-case/);
    expect(() => resolveCellNamespace('double--dash', 'slug')).toThrow(/kebab-case/);
    expect(() => resolveCellNamespace('-leading', 'slug')).toThrow(/kebab-case/);
    expect(() => resolveCellNamespace('trailing-', 'slug')).toThrow(/kebab-case/);
    expect(() => resolveCellNamespace('under_score', 'slug')).toThrow(/kebab-case/);
  });
});

describe('cellCustomerIdForGroup', () => {
  it('formats clawg-{namespace}-{group} with folder normalization', () => {
    expect(cellCustomerIdForGroup('My_Group', 'ns1')).toBe('clawg-ns1-my-group');
    expect(cellCustomerIdForGroup('assistant', 'ns1')).toBe('clawg-ns1-assistant');
  });

  it('keeps distinct namespaces distinct for the same group name', () => {
    expect(cellCustomerIdForGroup('assistant', 'alice')).not.toBe(cellCustomerIdForGroup('assistant', 'bob'));
  });

  it('truncates the NAMESPACE (never the group) to stay within 40 chars', () => {
    const ns = 'x'.repeat(24);
    const group = 'dm-with-someone-long'; // 20 chars
    const id = cellCustomerIdForGroup(group, ns);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.endsWith(`-${group}`)).toBe(true); // group intact
    expect(id.startsWith(CELL_GROUP_PREFIX)).toBe(true);
    // Budget: 40 - 'clawg-' (6) - '-' (1) - 20 = 13 namespace chars kept.
    expect(id).toBe(`clawg-${'x'.repeat(13)}-${group}`);
  });

  it('never leaves a trailing dash on a truncated namespace', () => {
    const ns = 'abc-def-ghi-jkl-mno-pqr'; // 23 chars, dashes at 4th positions
    const group = 'a'.repeat(30); // forces budget of 3 → 'abc' (dash stripped at 4)
    const id = cellCustomerIdForGroup(group, ns);
    expect(id).toBe(`clawg-abc-${group}`);
  });
});

describe('cleanupOrphanCellServices — namespace scoping', () => {
  it('stops ONLY this namespace: not the hosting cell, not sibling instances', async () => {
    const ns = getCellNamespace();
    const { client, stopped } = fakeClient([
      cell('claw-me'), // hosting cell — possibly the one WE run in
      cell('clawg-other-assistant'), // another instance's group cell
      cell(`${CELL_GROUP_PREFIX}${ns}-assistant`), // ours
    ]);
    _setCellClientForTesting(client);

    await cleanupOrphanCellServices();

    expect(stopped).toEqual([`dev--${CELL_GROUP_PREFIX}${ns}-assistant`]);
  });

  it('never touches bare claw-* cells even when a group name matches', async () => {
    const { client, stopped } = fakeClient([cell('claw-assistant'), cell('claw-dm-with-gavriel')]);
    _setCellClientForTesting(client);

    await cleanupOrphanCellServices();

    expect(stopped).toEqual([]);
  });

  it('also stops cells matched by exact id when the namespace was length-truncated', async () => {
    runMigrations(initTestDb());
    const longFolder = 'dm-with-a-very-long-display-name';
    createAgentGroup({
      id: 'ag-long',
      name: 'Long',
      folder: longFolder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const truncatedId = cellCustomerIdForGroup(longFolder); // ns segment truncated
    expect(truncatedId.startsWith(ownGroupCellPrefix())).toBe(false); // prefix match alone would miss it

    const { client, stopped } = fakeClient([cell(truncatedId), cell('clawg-other-thing')]);
    _setCellClientForTesting(client);

    await cleanupOrphanCellServices();

    expect(stopped).toEqual([`dev--${truncatedId}`]);
  });
});

describe('legacy claw-{group} cell detection', () => {
  it('warns (and does not stop) when a legacy-named cell exists for one of our groups', async () => {
    runMigrations(initTestDb());
    createAgentGroup({
      id: 'ag-1',
      name: 'Andy',
      folder: 'assistant',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const warn = vi.spyOn(log, 'warn');

    const { client, stopped } = fakeClient([cell(`${LEGACY_CELL_CUSTOMER_PREFIX}assistant`)]);
    _setCellClientForTesting(client);

    await cleanupOrphanCellServices();

    expect(stopped).toEqual([]); // never auto-adopted, never stopped
    const legacyWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('Legacy cell naming'));
    expect(legacyWarnings).toHaveLength(1);
    expect(legacyWarnings[0]![1]).toMatchObject({
      group: 'assistant',
      legacyCustomerId: 'claw-assistant',
      newCustomerId: cellCustomerIdForGroup('assistant'),
    });
  });

  it('stays silent once the namespaced cell exists', async () => {
    runMigrations(initTestDb());
    createAgentGroup({
      id: 'ag-1',
      name: 'Andy',
      folder: 'assistant',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const warn = vi.spyOn(log, 'warn');

    const { client } = fakeClient([
      cell(`${LEGACY_CELL_CUSTOMER_PREFIX}assistant`),
      cell(cellCustomerIdForGroup('assistant')),
    ]);
    _setCellClientForTesting(client);

    await cleanupOrphanCellServices();

    expect(warn.mock.calls.filter(([msg]) => String(msg).includes('Legacy cell naming'))).toHaveLength(0);
  });
});
