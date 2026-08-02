/**
 * Cell runner tests — mocked OnCell client only, no live API calls.
 *
 * Drives the real wake/kill lifecycle against an in-memory central DB and a
 * temp DATA_DIR/GROUPS_DIR (same pattern as session-manager.test.ts), with a
 * scripted fake client standing in for the OnCell API.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/oncellclaw-test-cell-runner/data',
    GROUPS_DIR: '/tmp/oncellclaw-test-cell-runner/groups',
  };
});

import {
  BOOTSTRAP_SCRIPT_CELL_PATH,
  buildCellClaudeSettings,
  buildServiceBootstrapScript,
  buildServiceEnv,
  buildSyncSources,
  getActiveCellSessionCount,
  isCellSessionRunning,
  killCellSession,
  wakeCellSession,
  _createHandleForTesting,
  _resetCellRunnerForTesting,
  _runPumpTickForTesting,
} from './cell-runner.js';
import { _setCellClientForTesting, cellCustomerIdForGroup } from './cell-runtime.js';
import type { ExecResult, OnCellClient, ServiceRecord } from './oncell-client.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { getDb } from './db/connection.js';
import { createSession } from './db/sessions.js';
import { heartbeatPath, initSessionFolder, outboundDbPath } from './session-manager.js';
import type { ContainerConfig } from './container-config.js';
import type { Session } from './types.js';

const TEST_ROOT = '/tmp/oncellclaw-test-cell-runner';
const SECRET = 'sk-ant-test-cell-secret';

interface FakeOnCell {
  client: OnCellClient;
  createCellCalls: string[];
  writes: Array<{ path: string; content: string }>;
  execCmds: string[];
  serviceStarts: Array<{ cmd: string; env?: Record<string, string> }>;
  stopServiceCalls: number;
  /** Override the scripted exec responder for a test. */
  execResponder?: (cmd: string) => Partial<ExecResult> | undefined;
  /** Override readFile content by cell path. */
  readFileContent?: (p: string) => string | undefined;
}

function okExec(overrides: Partial<ExecResult> = {}): ExecResult {
  return { exit_code: 0, stdout: '', stderr: '', truncated: false, duration_ms: 1, ...overrides };
}

function fakeOnCell(): FakeOnCell {
  const kv = new Map<string, unknown>();
  const fake: FakeOnCell = {
    createCellCalls: [],
    writes: [],
    execCmds: [],
    serviceStarts: [],
    stopServiceCalls: 0,
    client: undefined as unknown as OnCellClient,
  };
  fake.client = {
    createCell: (customerId: string) => {
      fake.createCellCalls.push(customerId);
      return Promise.resolve({ cell_id: `dev--${customerId}`, status: 'running' });
    },
    getCell: (cellId: string) => Promise.resolve({ cell_id: cellId, status: 'running' }),
    listCells: () => Promise.resolve([]),
    resumeCell: (cellId: string) => Promise.resolve({ cell_id: cellId, status: 'running' }),
    exec: (_cell: string, input: { cmd: string }) => {
      fake.execCmds.push(input.cmd);
      const custom = fake.execResponder?.(input.cmd);
      if (custom) return Promise.resolve(okExec(custom));
      if (input.cmd === 'pwd') return Promise.resolve(okExec({ stdout: '/ws\n' }));
      if (input.cmd.includes('HB $(stat')) return Promise.resolve(okExec({ stdout: 'HB 0\nSTAGED 0\n' }));
      return Promise.resolve(okExec());
    },
    request: <T = unknown>() => Promise.resolve({} as T),
    writeFile: (_cell: string, p: string, content: string) => {
      fake.writes.push({ path: p, content });
      return Promise.resolve({});
    },
    readFile: (_cell: string, p: string) => Promise.resolve({ content: fake.readFileContent?.(p) ?? '' }),
    kvGet: (_cell: string, key: string) => Promise.resolve({ value: kv.get(key) }),
    kvSet: (_cell: string, key: string, value: unknown) => {
      kv.set(key, value);
      return Promise.resolve({});
    },
    startService: (_cell: string, cmd: string, env?: Record<string, string>): Promise<ServiceRecord> => {
      fake.serviceStarts.push({ cmd, env });
      return Promise.resolve({ running: true, port: 8080 });
    },
    getService: () => Promise.resolve({ running: false }),
    stopService: () => {
      fake.stopServiceCalls += 1;
      return Promise.resolve();
    },
  };
  return fake;
}

const GROUP_ID = 'ag-cell-test';
const GROUP_FOLDER = 'main-chat';

function makeSession(id: string): Session {
  return {
    id,
    agent_group_id: GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

let fake: FakeOnCell;

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  createAgentGroup({
    id: GROUP_ID,
    name: 'Main Chat',
    folder: GROUP_FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  ensureContainerConfig(GROUP_ID, 'claude');
  // Keep the fixture light: no skills to mirror into the fake cell.
  getDb().prepare(`UPDATE container_configs SET skills = '[]' WHERE agent_group_id = ?`).run(GROUP_ID);

  fake = fakeOnCell();
  _setCellClientForTesting(fake.client);
  process.env.ANTHROPIC_API_KEY = SECRET;
});

afterEach(() => {
  _resetCellRunnerForTesting();
  _setCellClientForTesting(null);
  delete process.env.ANTHROPIC_API_KEY;
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('wakeCellSession', () => {
  it('creates the group cell on first wake and starts the runner service', async () => {
    const session = makeSession('sess-first');
    createSession(session);
    initSessionFolder(GROUP_ID, session.id);

    const woke = await wakeCellSession(session);

    expect(woke).toBe(true);
    expect(fake.createCellCalls).toEqual([cellCustomerIdForGroup(GROUP_FOLDER)]);
    // Namespaced scheme: clawg-{instance namespace}-{group folder} — the
    // bare claw-* prefix belongs to hosting cells and must never appear.
    expect(fake.createCellCalls[0]).toMatch(/^clawg-[a-z0-9-]+-main-chat$/);
    expect(fake.createCellCalls[0]!.startsWith('claw-')).toBe(false);
    expect(fake.serviceStarts.length).toBe(1);
    // The service cmd runs the STAGED bootstrap script (which installs what
    // is missing using the service's network, then execs the bun runner) —
    // never a bare runner invocation that assumes bun exists.
    expect(fake.serviceStarts[0].cmd).toBe(`sh '/ws/${BOOTSTRAP_SCRIPT_CELL_PATH}'`);
    const staged = fake.writes.find((w) => w.path === BOOTSTRAP_SCRIPT_CELL_PATH);
    expect(staged).toBeDefined();
    expect(staged!.content).toContain('exec bun');
    expect(staged!.content).toContain('cell-service.ts');
    // Bootstrap must NOT happen over exec — exec sandboxes have no network.
    expect(fake.execCmds.every((cmd) => !cmd.includes('npm install') && !cmd.includes('curl'))).toBe(true);
    expect(isCellSessionRunning(session.id)).toBe(true);
    expect(getActiveCellSessionCount()).toBe(1);
    // inbound.db was pushed to the cell before the service started
    expect(fake.writes.some((w) => w.path === 'claw/session/inbound.db.__push')).toBe(true);
  });

  it('passes credentials via service env and NEVER writes them into cell files', async () => {
    const session = makeSession('sess-creds');
    createSession(session);
    initSessionFolder(GROUP_ID, session.id);

    await wakeCellSession(session);

    const env = fake.serviceStarts[0].env!;
    expect(env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(env.NANOCLAW_WORKSPACE_ROOT).toBe('/ws/claw/session');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/ws/claw/claude');
    expect(env.TZ).toBeTruthy();
    // The secret must not appear in any write_file payload or exec command.
    expect(fake.writes.every((w) => !w.content.includes(SECRET) && !w.path.includes(SECRET))).toBe(true);
    expect(fake.execCmds.every((cmd) => !cmd.includes(SECRET))).toBe(true);
  });

  it('defers a second session of the same group while another holds the cell', async () => {
    const first = makeSession('sess-holder');
    const second = makeSession('sess-waiter');
    createSession(first);
    createSession(second);
    initSessionFolder(GROUP_ID, first.id);
    initSessionFolder(GROUP_ID, second.id);

    expect(await wakeCellSession(first)).toBe(true);
    expect(await wakeCellSession(second)).toBe(false);
    expect(fake.serviceStarts.length).toBe(1);
    expect(isCellSessionRunning(second.id)).toBe(false);
  });

  it('is idempotent for an already-running session', async () => {
    const session = makeSession('sess-idem');
    createSession(session);
    initSessionFolder(GROUP_ID, session.id);

    await wakeCellSession(session);
    const again = await wakeCellSession(session);

    expect(again).toBe(true);
    expect(fake.serviceStarts.length).toBe(1);
  });
});

describe('killCellSession', () => {
  it('stops the service, releases the cell and fires onExit', async () => {
    const session = makeSession('sess-kill');
    createSession(session);
    initSessionFolder(GROUP_ID, session.id);
    await wakeCellSession(session);

    let exited = false;
    killCellSession(session.id, 'test', () => {
      exited = true;
    });

    await vi.waitFor(() => {
      expect(exited).toBe(true);
    });
    expect(fake.stopServiceCalls).toBe(1);
    expect(isCellSessionRunning(session.id)).toBe(false);
    // The cell is free again: a second session can now take it.
    const next = makeSession('sess-next');
    createSession(next);
    initSessionFolder(GROUP_ID, next.id);
    expect(await wakeCellSession(next)).toBe(true);
  });
});

describe('pump IPC round-trip', () => {
  it('pulls a staged outbound.db, mirrors the heartbeat, and fetches outbox files', async () => {
    const session = makeSession('sess-pump');
    createSession(session);
    initSessionFolder(GROUP_ID, session.id);
    const handle = _createHandleForTesting(session, 'claw-main-chat', 'dev--claw-main-chat');

    const outboundBytes = Buffer.from('SQLite format 3 cell-outbound');
    const attachment = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const hbEpoch = Math.floor(Date.now() / 1000) - 7;
    fake.execResponder = (cmd) => {
      if (cmd.includes('HB $(stat')) {
        return { stdout: `HB ${hbEpoch}\nSTAGED 1\nOUTBOX outbox/msg-9/pic.png\n` };
      }
      return undefined;
    };
    fake.readFileContent = (p) => {
      if (p.endsWith('.outbound.pull.b64')) return outboundBytes.toString('base64');
      if (p.includes('outbox/msg-9/pic.png')) return attachment.toString('base64');
      return undefined;
    };

    await _runPumpTickForTesting(fake.client, handle);

    // outbound.db landed locally (delivery poll reads it unchanged)
    expect(fs.readFileSync(outboundDbPath(GROUP_ID, session.id)).equals(outboundBytes)).toBe(true);
    // heartbeat mtime mirrored for host-sweep liveness
    expect(Math.floor(fs.statSync(heartbeatPath(GROUP_ID, session.id)).mtimeMs / 1000)).toBe(hbEpoch);
    // outbox attachment pulled into the local session dir
    const localAttachment = path.join(
      TEST_ROOT,
      'data',
      'v2-sessions',
      GROUP_ID,
      session.id,
      'outbox',
      'msg-9',
      'pic.png',
    );
    expect(fs.readFileSync(localAttachment).equals(attachment)).toBe(true);
    // inbound.db was pushed cell-ward during the same tick
    expect(fake.writes.some((w) => w.path === 'claw/session/inbound.db.__push')).toBe(true);
  });
});

describe('service plumbing helpers', () => {
  it('buildServiceEnv contains creds + path overrides and nothing else unexpected', () => {
    const config = { timezone: 'UTC' } as unknown as ContainerConfig;
    const env = buildServiceEnv('/ws', config);
    expect(env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(env.TZ).toBe('UTC');
    expect(env.NANOCLAW_WORKSPACE_ROOT).toBe('/ws/claw/session');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/ws/claw/claude');
    expect(env.NANOCLAW_CELL).toBe('1');
  });

  it('buildServiceEnv withholds raw credentials in gateway (vault) mode', () => {
    const config = { timezone: 'UTC' } as unknown as ContainerConfig;
    const env = buildServiceEnv('/ws', config, { ANTHROPIC_BASE_URL: 'https://gw.onecli.sh/v1' });
    // The vault injects credentials at request time — the raw key must NOT
    // ride along, or the gateway is decorative.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.onecli.sh/v1');
    expect(env.NANOCLAW_CELL).toBe('1');
  });

  it('buildServiceBootstrapScript pins the claude-code version when known', () => {
    expect(buildServiceBootstrapScript('2.1.197', 'm1', '/ws')).toContain('@anthropic-ai/claude-code@2.1.197');
    expect(buildServiceBootstrapScript('', 'm1', '/ws')).toMatch(/npm install -g .* @anthropic-ai\/claude-code$/m);
  });

  it('buildServiceBootstrapScript is node-only, port-holding, marker-gated and self-executing', () => {
    const script = buildServiceBootstrapScript('2.1.197', 'v2:123:claude=2.1.197', '/ws');
    // Node-only: bun arrives via npm — there is no curl in a cell.
    expect(script).not.toContain('curl');
    expect(script).toContain('npm install -g --prefix "$TOOLS" --no-fund --no-audit --loglevel=error bun');
    // Readiness: a placeholder binds $PORT before the slow installs.
    expect(script).toContain('"phase\\":\\"bootstrap\\"');
    expect(script).toContain('placeholder_pid=$!');
    // Idempotency: marker file short-circuits warm wakes.
    expect(script).toContain("MARKER='v2:123:claude=2.1.197'");
    expect(script).toContain('claw/.bootstrap-marker');
    // Hand-off: the runner replaces the shell.
    expect(script).toContain("exec bun '/ws/claw/runner/src/cell-service.ts'");
  });

  it('buildCellClaudeSettings points the PreCompact hook at the synced runner', () => {
    const settings = JSON.parse(buildCellClaudeSettings('/ws')) as {
      hooks: { PreCompact: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.PreCompact[0].hooks[0].command).toBe('bun /ws/claw/runner/src/compact-instructions.ts');
  });

  it('buildSyncSources mirrors group dir, shared CLAUDE.md and the runner — never a .env source', () => {
    const config = { skills: [] } as unknown as ContainerConfig;
    const sources = buildSyncSources(
      { id: GROUP_ID, name: 'Main Chat', folder: GROUP_FOLDER, agent_provider: null, created_at: '' },
      config,
    );
    const cellPaths = sources.map((s) => s.cellPath);
    expect(cellPaths).toContain('claw/agent');
    expect(cellPaths).toContain('claw/app/CLAUDE.md');
    expect(cellPaths).toContain('claw/runner/src');
    expect(sources.every((s) => !s.localPath.endsWith('.env'))).toBe(true);
  });
});

describe('runtime dispatch (structural)', () => {
  const runnerSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');

  it('every container-runner entry point dispatches to the cell runner on oncell', () => {
    expect(runnerSrc).toContain(`if (ACTIVE_RUNTIME === 'oncell') return wakeCellSession(session);`);
    expect(runnerSrc).toContain(`if (ACTIVE_RUNTIME === 'oncell') return isCellSessionRunning(sessionId);`);
    expect(runnerSrc).toContain(`if (ACTIVE_RUNTIME === 'oncell') return getActiveCellSessionCount();`);
    expect(runnerSrc).toContain(`killCellSession(sessionId, reason, onExit);`);
    expect(runnerSrc).toContain(`if (ACTIVE_RUNTIME === 'oncell') return installCellPackages(agentGroupId);`);
  });
});
