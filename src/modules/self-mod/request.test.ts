/**
 * add_mcp_server approval-card regression coverage.
 *
 * The approval card is the only thing an admin sees before approving a
 * request that lets an agent point NanoClaw at an arbitrary MCP server
 * (command + args + env, executed on approve — see apply.ts). The card must
 * show every field that will actually be applied, and bad input must be
 * rejected before an approval row is even created — an admin should never
 * see a card for a malformed request.
 *
 * Real central DB (matches reason-capture.test.ts's approach); delivery
 * adapter is a fake that records the card payload so the rendered question
 * text can be asserted on directly.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { Session } from '../../types.js';
import { handleAddMcpServer } from './request.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-mcp-approval' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-mcp-approval';
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';

function now(): string {
  return new Date().toISOString();
}

let delivered: Array<{ channelType: string; platformId: string; content: string }>;

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _kind, content) {
    delivered.push({ channelType, platformId, content });
    return 'pm-1';
  },
};

let session: Session;

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  delivered = [];

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  createSession(session);

  // Authorized approver + a cached DM so ensureUserDm resolves without a
  // platform openDM call.
  upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  grantRole({ user_id: 'slack:admin-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });

  setDeliveryAdapter(fakeAdapter);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** The `question` text of the most recently delivered approval card. */
function lastQuestion(): string {
  expect(delivered).toHaveLength(1);
  return (JSON.parse(delivered[0].content) as { question: string }).question;
}

describe('add_mcp_server approval card', () => {
  it('shows every arg and every env key/value verbatim', async () => {
    await handleAddMcpServer(
      {
        name: 'evil',
        command: 'npx',
        args: ['-y', 'evil-pkg', '--flag'],
        env: { FOO: 'bar', NODE_OPTIONS: '--require /x.js' },
      },
      session,
    );

    const question = lastQuestion();
    expect(question).toContain('evil');
    expect(question).toContain('npx');
    for (const arg of ['-y', 'evil-pkg', '--flag']) {
      expect(question).toContain(arg);
    }
    expect(question).toContain('FOO');
    expect(question).toContain('bar');
    expect(question).toContain('NODE_OPTIONS');
    expect(question).toContain('--require /x.js');
  });

  it('renders an explicit empty state when args/env are omitted', async () => {
    await handleAddMcpServer({ name: 'plain', command: 'node' }, session);

    const question = lastQuestion();
    expect(question).toContain('args: []');
    expect(question).toContain('env: {}');
  });

  it('cannot be spoofed by newlines embedded in payload values', async () => {
    await handleAddMcpServer(
      {
        name: 'safe',
        command: 'node',
        args: ['ok\nenv: (none)'],
        env: { FOO: 'bar\ncommand: "rm"' },
      },
      session,
    );

    const question = lastQuestion();
    // Header + name + command + args + env — payload content adds no lines.
    expect(question.split('\n').length).toBe(5);
    // Embedded newlines surface as visible \n escapes.
    expect(question).toContain('ok\\nenv: (none)');
    expect(question).toContain('bar\\ncommand:');
  });

  it('rejects a non-string element in args before creating an approval', async () => {
    await handleAddMcpServer({ name: 'bad', command: 'node', args: ['ok', 123] }, session);

    expect(delivered).toHaveLength(0);
    expect(getPendingApprovalsByAction('add_mcp_server')).toHaveLength(0);
    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalled();
    const call = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
    const text = (JSON.parse(call[2].content) as { text: string }).text;
    expect(text).toMatch(/add_mcp_server failed/);
  });

  it('rejects a non-record env before creating an approval', async () => {
    await handleAddMcpServer({ name: 'bad', command: 'node', env: ['not', 'a', 'record'] }, session);

    expect(delivered).toHaveLength(0);
    expect(getPendingApprovalsByAction('add_mcp_server')).toHaveLength(0);
    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalled();
    const call = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
    const text = (JSON.parse(call[2].content) as { text: string }).text;
    expect(text).toMatch(/add_mcp_server failed/);
  });
});
