/**
 * Cell pre-warm — the boot-time background wake of the default web group.
 * The wake itself is mocked (container-runner); under test is the seam:
 * which session gets woken, the no-double-wake throttle, and the
 * fail-safe no-op paths (no web group, no wiring, resolver throwing).
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/oncellclaw-test-prewarm/data' };
});

import { isContainerRunning, wakeContainer } from './container-runner.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { prewarmDefaultGroupCell } from './prewarm.js';
import { findSession } from './db/sessions.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/oncellclaw-test-prewarm';

function now(): string {
  return new Date().toISOString();
}

function seedWebGroup(slug: string): void {
  createAgentGroup({ id: `ag-${slug}`, name: 'Andy', folder: slug, agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: `mg-${slug}`,
    channel_type: 'web',
    platform_id: slug,
    instance: 'web',
    name: 'Assistant',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: `mga-${slug}`,
    messaging_group_id: `mg-${slug}`,
    agent_group_id: `ag-${slug}`,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
  vi.mocked(wakeContainer).mockClear();
  vi.mocked(isContainerRunning).mockClear();
  vi.mocked(isContainerRunning).mockReturnValue(false);
});

afterEach(() => {
  closeDb();
  delete process.env.ONCELLCLAW_GROUP;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('prewarmDefaultGroupCell', () => {
  it("wakes the default group's session through the normal message-wake path", () => {
    seedWebGroup('assistant');

    prewarmDefaultGroupCell();

    expect(wakeContainer).toHaveBeenCalledTimes(1);
    const session = vi.mocked(wakeContainer).mock.calls[0]![0] as Session;
    expect(session.agent_group_id).toBe('ag-assistant');
    expect(session.messaging_group_id).toBe('mg-assistant');
    // The session it woke is the SAME row a first message would resolve —
    // pre-warm rides the normal path, no parallel bookkeeping.
    expect(findSession('mg-assistant', null)?.id).toBe(session.id);
  });

  it('honors ONCELLCLAW_GROUP for non-default slugs', () => {
    seedWebGroup('concierge');
    process.env.ONCELLCLAW_GROUP = 'concierge';

    prewarmDefaultGroupCell();

    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect((vi.mocked(wakeContainer).mock.calls[0]![0] as Session).agent_group_id).toBe('ag-concierge');
  });

  it('throttles: never wakes when a runner is already live for the session', () => {
    seedWebGroup('assistant');
    vi.mocked(isContainerRunning).mockReturnValue(true);

    prewarmDefaultGroupCell();

    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('no-ops without a provisioned web group (self-host without web provision)', () => {
    prewarmDefaultGroupCell();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('no-ops when the web group has no wired agent', () => {
    createAgentGroup({ id: 'ag-x', name: 'X', folder: 'assistant', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-x',
      channel_type: 'web',
      platform_id: 'assistant',
      instance: 'web',
      name: 'Assistant',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    prewarmDefaultGroupCell();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('never throws — a broken wake path degrades to lazy first-message bootstrap', () => {
    seedWebGroup('assistant');
    vi.mocked(isContainerRunning).mockImplementation(() => {
      throw new Error('runtime exploded');
    });

    expect(() => prewarmDefaultGroupCell()).not.toThrow();
    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
