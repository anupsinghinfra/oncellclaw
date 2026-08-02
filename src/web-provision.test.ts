/**
 * Non-interactive provisioning: does it create the right things once, and
 * nothing the second time?
 *
 * Idempotency is the whole contract here — `scripts/cloud-start.sh` runs
 * this on every service start, and a supervised service restarts often.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-provision/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-provision/groups',
  };
});

import { closeDb, getDb, initTestDb, runMigrations } from './db/index.js';
import { getAllAgentGroups, getAgentGroupByFolder } from './db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupsByChannel } from './db/messaging-groups.js';
import { getUserRoles } from './modules/permissions/db/user-roles.js';
import { provisionWebGroup } from './web-provision.js';
// Registration-only: makes the `web` channel's declared defaults resolvable
// without a live adapter — exactly how scripts/provision.ts imports it.
import './channels/index.js';

const TEST_ROOT = '/tmp/nanoclaw-test-provision';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('provisionWebGroup', () => {
  it('creates the agent group, workspace, messaging group and wiring on first run', () => {
    const result = provisionWebGroup({ group: 'assistant', persona: 'You are terse.' });

    expect(result.created).toEqual({
      agentGroup: true,
      messagingGroup: true,
      wiring: true,
      ownerGrant: true,
    });

    const ag = getAgentGroupByFolder('assistant');
    expect(ag?.id).toBe(result.agentGroupId);

    const mgs = getMessagingGroupsByChannel('web');
    expect(mgs).toHaveLength(1);
    expect(mgs[0]!.platform_id).toBe('assistant');
    expect(mgs[0]!.instance).toBe('web');
    // Declared by the channel, not hardcoded here: the bearer token is the
    // trust boundary, so senders are 'public'.
    expect(mgs[0]!.unknown_sender_policy).toBe('public');

    const wirings = getMessagingGroupAgents(result.messagingGroupId);
    expect(wirings).toHaveLength(1);
    expect(wirings[0]!.engage_mode).toBe('pattern');
    expect(wirings[0]!.engage_pattern).toBe('.');

    // Persona staged as the group's standing instructions.
    expect(fs.readFileSync(path.join(GROUPS_DIR, 'assistant', 'instructions.prepend.md'), 'utf-8')).toContain(
      'You are terse.',
    );

    expect(getUserRoles(result.ownerUserId).some((r) => r.role === 'owner' && r.agent_group_id === null)).toBe(true);
  });

  it('is a no-op on a second run — no duplicate group, messaging group, or wiring', () => {
    const first = provisionWebGroup({ group: 'assistant', persona: 'You are terse.' });
    const second = provisionWebGroup({ group: 'assistant', persona: 'You are terse.' });

    expect(second.created).toEqual({
      agentGroup: false,
      messagingGroup: false,
      wiring: false,
      ownerGrant: false,
    });
    expect(second.agentGroupId).toBe(first.agentGroupId);
    expect(second.messagingGroupId).toBe(first.messagingGroupId);

    expect(getAllAgentGroups()).toHaveLength(1);
    expect(getMessagingGroupsByChannel('web')).toHaveLength(1);
    expect(getMessagingGroupAgents(first.messagingGroupId)).toHaveLength(1);
    expect(getUserRoles(first.ownerUserId).filter((r) => r.role === 'owner')).toHaveLength(1);
    // The companion destination row is created once, not once per run.
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM agent_destinations WHERE agent_group_id = ?').get(first.agentGroupId),
    ).toEqual({ n: 1 });
  });

  it('never overwrites a persona edited after provisioning', () => {
    provisionWebGroup({ group: 'assistant', persona: 'original' });
    const personaFile = path.join(GROUPS_DIR, 'assistant', 'instructions.prepend.md');
    fs.writeFileSync(personaFile, 'edited in place\n');

    provisionWebGroup({ group: 'assistant', persona: 'a different persona' });

    expect(fs.readFileSync(personaFile, 'utf-8')).toBe('edited in place\n');
  });

  it('normalizes the group name into the slug used by the URL and the folder', () => {
    const result = provisionWebGroup({ group: 'My Assistant!' });
    expect(result.slug).toBe('my-assistant');
    expect(getAgentGroupByFolder('my-assistant')).toBeDefined();
    expect(getMessagingGroupsByChannel('web')[0]!.platform_id).toBe('my-assistant');
    // Display name keeps the human spelling.
    expect(getAgentGroupByFolder('my-assistant')!.name).toBe('My Assistant!');
  });

  it('rejects a group name with no usable characters', () => {
    expect(() => provisionWebGroup({ group: '!!!' })).toThrow(/Invalid group name/);
  });

  it('provisions a second, differently-named group alongside the first', () => {
    const a = provisionWebGroup({ group: 'assistant' });
    const b = provisionWebGroup({ group: 'research' });

    expect(b.created.agentGroup).toBe(true);
    expect(b.agentGroupId).not.toBe(a.agentGroupId);
    expect(getMessagingGroupsByChannel('web')).toHaveLength(2);
    // The owner grant is global and already held — not re-granted.
    expect(b.created.ownerGrant).toBe(false);
  });
});
