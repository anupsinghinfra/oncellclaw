/**
 * Web channel — the HTTP contract.
 *
 * Real HTTP server on a fixed port, real fetch, real router. Nothing here
 * touches the network beyond loopback: no adapter, no OnCell API, no
 * container. Conventions follow webhook-server.test.ts.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Containers never spawn in tests — the router's wake is a no-op.
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-web-channel' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../db/index.js';
import { findSession } from '../db/sessions.js';
import { routeInbound } from '../router.js';
import { inboundDbPath, openOutboundDbRw, resolveSession } from '../session-manager.js';
import { stopWebhookServer } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import {
  getActiveAdapters,
  getChannelDefaults,
  getRegisteredChannelNames,
  initChannelAdapters,
  teardownChannelAdapters,
} from './channel-registry.js';
// Self-registers the `web` channel into the registry.
import './web.js';

const TEST_DIR = '/tmp/nanoclaw-test-web-channel';
const PORT = 3921;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'sekrit-token-0123456789';
const GROUP = 'assistant';

function now(): string {
  return new Date().toISOString();
}

/**
 * The host's adapter→router seam, verbatim from src/index.ts except that
 * onInbound returns the routing promise so assertions don't race the
 * background write. Production returns void (202 Accepted, routing
 * continues); the code under test awaits whatever it gets, so both shapes
 * exercise the same call.
 */
function hostSetup(adapter: ChannelAdapter): ChannelSetup {
  return {
    onInbound(platformId, threadId, message) {
      return routeInbound({
        channelType: adapter.channelType,
        instance: adapter.instance ?? adapter.channelType,
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: JSON.stringify(message.content),
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
        },
      });
    },
    onInboundEvent: (event) => routeInbound(event),
    onMetadata: () => {},
    onAction: () => {},
  };
}

/** Boot the registered channels with the given env. Empty string = unset. */
async function startChannels(env: {
  token?: string;
  allowInsecure?: string;
  authFailuresPerMin?: string;
  messagesPerMin?: string;
}): Promise<void> {
  process.env.ONCELLCLAW_WEB_TOKEN = env.token ?? '';
  process.env.ONCELLCLAW_WEB_ALLOW_INSECURE = env.allowInsecure ?? '';
  process.env.ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN = env.authFailuresPerMin ?? '';
  process.env.ONCELLCLAW_WEB_MESSAGES_PER_MIN = env.messagesPerMin ?? '';
  await initChannelAdapters(hostSetup);
}

/** The server starts listening asynchronously — retry briefly on refusal. */
async function req(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`${BASE}${path}`, init);
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function auth(token = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function seedGroup(): void {
  createAgentGroup({ id: 'ag-web', name: 'Andy', folder: 'assistant', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-web',
    channel_type: 'web',
    platform_id: GROUP,
    instance: 'web',
    name: 'Assistant',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-web',
    messaging_group_id: 'mg-web',
    agent_group_id: 'ag-web',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

/** Write an outbound row with an explicit timestamp (deterministic cursors). */
function seedOutbound(sessionId: string, id: string, timestamp: string, text: string): void {
  const db = openOutboundDbRw('ag-web', sessionId);
  try {
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), ?, 'chat', ?, 'web', NULL, ?)`,
    ).run(id, timestamp, GROUP, JSON.stringify({ text }));
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  process.env.WEBHOOK_PORT = String(PORT);
  runMigrations(initTestDb());
});

afterEach(async () => {
  await teardownChannelAdapters();
  await stopWebhookServer();
  closeDb();
  delete process.env.WEBHOOK_PORT;
  delete process.env.ONCELLCLAW_WEB_TOKEN;
  delete process.env.ONCELLCLAW_WEB_ALLOW_INSECURE;
  delete process.env.ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN;
  delete process.env.ONCELLCLAW_WEB_MESSAGES_PER_MIN;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('web channel — registry and declared defaults', () => {
  it('registers `web` as a first-class channel', () => {
    expect(getRegisteredChannelNames()).toContain('web');
  });

  it('declares DM defaults resolvable without a live adapter', () => {
    // Offline creation surfaces (ncl, scripts/provision.ts) read the
    // registration's declaration, so this must resolve with nothing running.
    const decl = getChannelDefaults('web');
    expect(decl.dm).toEqual({
      engageMode: 'pattern',
      engagePattern: '.',
      threads: false,
      unknownSenderPolicy: 'public',
    });
    expect(decl.mentions).toBe('dm-only');
  });
});

describe('web channel — startup gate', () => {
  it('refuses to start when ONCELLCLAW_WEB_TOKEN is unset', async () => {
    await startChannels({ token: '' });
    expect(getActiveAdapters().find((a) => a.channelType === 'web')).toBeUndefined();
  });

  it('starts unauthenticated only when ONCELLCLAW_WEB_ALLOW_INSECURE=1', async () => {
    seedGroup();
    await startChannels({ token: '', allowInsecure: '1' });
    expect(getActiveAdapters().find((a) => a.channelType === 'web')).toBeDefined();

    const res = await req(`/web/${GROUP}/messages`);
    expect(res.status).toBe(200);
  });

  it('starts with a token present', async () => {
    await startChannels({ token: TOKEN });
    const adapter = getActiveAdapters().find((a) => a.channelType === 'web');
    expect(adapter?.isConnected()).toBe(true);
  });
});

describe('web channel — auth', () => {
  beforeEach(async () => {
    seedGroup();
    await startChannels({ token: TOKEN });
  });

  it('rejects a missing bearer token', async () => {
    const res = await req(`/web/${GROUP}/messages`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong bearer token, including a prefix of the real one', async () => {
    const wrong = await req(`/web/${GROUP}/messages`, { headers: auth('nope') });
    expect(wrong.status).toBe(401);

    const prefix = await req(`/web/${GROUP}/messages`, { headers: auth(TOKEN.slice(0, -1)) });
    expect(prefix.status).toBe(401);
  });

  it('rejects an unauthenticated POST before it can reach the router', async () => {
    const res = await req(`/web/${GROUP}/message`, {
      method: 'POST',
      body: JSON.stringify({ text: 'sneak' }),
    });
    expect(res.status).toBe(401);
    expect(findSession('mg-web', null)).toBeUndefined();
  });

  it('accepts the correct bearer token', async () => {
    const res = await req(`/web/${GROUP}/messages`, { headers: auth() });
    expect(res.status).toBe(200);
  });

  it('serves /health without a token', async () => {
    const res = await req('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, groups: [{ slug: GROUP, name: 'Assistant', agents: 1 }] });
  });

  it('serves the same health at /web/health without a token (hosted preview proxies reserve top-level /health)', async () => {
    const res = await req('/web/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, groups: [{ slug: GROUP, name: 'Assistant', agents: 1 }] });
  });
});

describe('web channel — POST /web/:group/message', () => {
  beforeEach(async () => {
    seedGroup();
    await startChannels({ token: TOKEN });
  });

  it('enqueues through the real router path into the session inbound DB', async () => {
    const res = await req(`/web/${GROUP}/message`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello from a browser', userId: 'alice' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true });

    const session = findSession('mg-web', null);
    expect(session).toBeDefined();

    const inbound = new Database(inboundDbPath('ag-web', session!.id));
    const rows = inbound.prepare('SELECT * FROM messages_in').all() as Array<{
      content: string;
      channel_type: string;
      platform_id: string;
      thread_id: string | null;
    }>;
    inbound.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel_type).toBe('web');
    expect(rows[0]!.platform_id).toBe(GROUP);
    expect(rows[0]!.thread_id).toBeNull();
    expect(JSON.parse(rows[0]!.content)).toMatchObject({
      text: 'hello from a browser',
      sender: 'alice',
      senderId: 'web:alice',
    });
  });

  it('defaults the sender to the instance owner when userId is omitted', async () => {
    await req(`/web/${GROUP}/message`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ text: 'no user id' }),
    });
    const session = findSession('mg-web', null)!;
    const inbound = new Database(inboundDbPath('ag-web', session.id));
    const row = inbound.prepare('SELECT content FROM messages_in').get() as { content: string };
    inbound.close();
    expect(JSON.parse(row.content).senderId).toBe('web:owner');
  });

  it('rejects an empty text, invalid JSON, and an unusable userId', async () => {
    const empty = await req(`/web/${GROUP}/message`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ text: '   ' }),
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'text_required' });

    const bad = await req(`/web/${GROUP}/message`, { method: 'POST', headers: auth(), body: 'not json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_json' });

    const badUser = await req(`/web/${GROUP}/message`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ text: 'hi', userId: 'a/b c' }),
    });
    expect(badUser.status).toBe(400);
    expect(await badUser.json()).toEqual({ error: 'invalid_user_id' });

    expect(findSession('mg-web', null)).toBeUndefined();
  });

  it('404s an unknown group instead of auto-creating a messaging group', async () => {
    const res = await req('/web/not-a-group/message', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'unknown_group' });
  });

  it('405s a GET on the message endpoint', async () => {
    const res = await req(`/web/${GROUP}/message`, { headers: auth() });
    expect(res.status).toBe(405);
  });
});

describe('web channel — GET /web/:group/messages', () => {
  let sessionId: string;

  beforeEach(async () => {
    seedGroup();
    // resolveSession materializes the session folder + both DBs.
    sessionId = resolveSession('ag-web', 'mg-web', null, 'shared').session.id;
    await startChannels({ token: TOKEN });
  });

  it('returns outbound messages the delivery path wrote, in order, with a cursor', async () => {
    seedOutbound(sessionId, 'out-1', '2026-01-01T00:00:01.000Z', 'first');
    seedOutbound(sessionId, 'out-2', '2026-01-01T00:00:02.000Z', 'second');

    const res = await req(`/web/${GROUP}/messages`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; text: string; cursor: string }>;
      cursor: string;
    };

    expect(body.messages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(body.messages[0]!.id).toBe('out-1');
    expect(body.cursor).toBe(body.messages[1]!.cursor);
  });

  it('returns only messages after the supplied cursor', async () => {
    seedOutbound(sessionId, 'out-1', '2026-01-01T00:00:01.000Z', 'first');
    seedOutbound(sessionId, 'out-2', '2026-01-01T00:00:02.000Z', 'second');
    seedOutbound(sessionId, 'out-3', '2026-01-01T00:00:03.000Z', 'third');

    const first = (await (await req(`/web/${GROUP}/messages`, { headers: auth() })).json()) as {
      messages: Array<{ cursor: string }>;
    };
    const afterFirst = first.messages[0]!.cursor;

    const res = await req(`/web/${GROUP}/messages?after=${encodeURIComponent(afterFirst)}`, { headers: auth() });
    const body = (await res.json()) as { messages: Array<{ text: string }>; cursor: string };
    expect(body.messages.map((m) => m.text)).toEqual(['second', 'third']);

    // Polling again from the newest cursor yields nothing and echoes it back.
    const drained = await req(`/web/${GROUP}/messages?after=${encodeURIComponent(body.cursor)}`, { headers: auth() });
    const drainedBody = (await drained.json()) as { messages: unknown[]; cursor: string };
    expect(drainedBody.messages).toEqual([]);
    expect(drainedBody.cursor).toBe(body.cursor);
  });

  it('excludes internal traffic addressed at other channels', async () => {
    seedOutbound(sessionId, 'out-web', '2026-01-01T00:00:01.000Z', 'for the browser');
    const db = openOutboundDbRw('ag-web', sessionId);
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES ('out-sys', 99, '2026-01-01T00:00:02.000Z', 'system', NULL, NULL, NULL, '{"action":"cli_request"}'),
              ('out-a2a', 101, '2026-01-01T00:00:03.000Z', 'chat', 'ag-other', 'agent', NULL, '{"text":"peer"}')`,
    ).run();
    db.close();

    const body = (await (await req(`/web/${GROUP}/messages`, { headers: auth() })).json()) as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((m) => m.id)).toEqual(['out-web']);
  });

  it('honors the limit parameter and caps it', async () => {
    for (let i = 1; i <= 5; i++) {
      seedOutbound(sessionId, `out-${i}`, `2026-01-01T00:00:0${i}.000Z`, `m${i}`);
    }
    const body = (await (await req(`/web/${GROUP}/messages?limit=2`, { headers: auth() })).json()) as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((m) => m.id)).toEqual(['out-1', 'out-2']);
  });

  it('returns an empty stream (not an error) before any session exists', async () => {
    createAgentGroup({ id: 'ag-2', name: 'Second', folder: 'second', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'web',
      platform_id: 'second',
      instance: 'web',
      name: 'Second',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const res = await req('/web/second/messages', { headers: auth() });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ messages: [], cursor: '' });
  });
});

describe('web channel — routing surface', () => {
  beforeEach(async () => {
    seedGroup();
    await startChannels({ token: TOKEN });
  });

  it('404s paths that are not the two documented endpoints', async () => {
    expect((await req(`/web/${GROUP}`, { headers: auth() })).status).toBe(404);
    expect((await req(`/web/${GROUP}/messages/extra`, { headers: auth() })).status).toBe(404);
    expect((await req('/nope', { headers: auth() })).status).toBe(404);
  });

  it('shares the one port with the webhook routes', async () => {
    // /webhook is still handled by its own table on the same server.
    expect((await req('/webhook/unknown-adapter')).status).toBe(404);
  });
});

describe('web channel — rate limiting', () => {
  it('429s auth attempts from an IP that exhausted its failure budget — before the token compare', async () => {
    seedGroup();
    await startChannels({ token: TOKEN, authFailuresPerMin: '2' });

    // Burn the budget with two failures.
    expect((await req(`/web/${GROUP}/messages`, { headers: auth('wrong-1') })).status).toBe(401);
    expect((await req(`/web/${GROUP}/messages`, { headers: auth('wrong-2') })).status).toBe(401);

    // Third bad attempt: 429, generic body, Retry-After present.
    const blocked = await req(`/web/${GROUP}/messages`, { headers: auth('wrong-3') });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'rate_limited' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Even the CORRECT token is refused — the gate sits before the compare,
    // so the response carries zero signal about token correctness.
    const evenCorrect = await req(`/web/${GROUP}/messages`, { headers: auth() });
    expect(evenCorrect.status).toBe(429);
    expect(await evenCorrect.json()).toEqual({ error: 'rate_limited' });
  });

  it('scopes the auth-failure budget per client IP (first X-Forwarded-For entry)', async () => {
    seedGroup();
    await startChannels({ token: TOKEN, authFailuresPerMin: '1' });

    const asIp = (ip: string, token: string) =>
      req(`/web/${GROUP}/messages`, { headers: { ...auth(token), 'X-Forwarded-For': ip } });

    expect((await asIp('203.0.113.7', 'bad')).status).toBe(401); // budget spent
    expect((await asIp('203.0.113.7', 'bad')).status).toBe(429); // over budget
    // A different client IP still has its own budget → 401, not 429.
    expect((await asIp('203.0.113.8', 'bad')).status).toBe(401);
    // Only the FIRST XFF entry counts — appending the blocked IP later in
    // the chain must not confuse the limiter.
    const chained = await req(`/web/${GROUP}/messages`, {
      headers: { ...auth('bad'), 'X-Forwarded-For': '203.0.113.9, 203.0.113.7' },
    });
    expect(chained.status).toBe(401);
  });

  it('does not spend auth budget on successful requests', async () => {
    seedGroup();
    await startChannels({ token: TOKEN, authFailuresPerMin: '1' });

    for (let i = 0; i < 5; i++) {
      expect((await req(`/web/${GROUP}/messages`, { headers: auth() })).status).toBe(200);
    }
    // The single failure allowance is still intact.
    expect((await req(`/web/${GROUP}/messages`, { headers: auth('bad') })).status).toBe(401);
  });

  it('429s message POSTs over the per-group budget; GET polls stay unlimited', async () => {
    seedGroup();
    await startChannels({ token: TOKEN, messagesPerMin: '2' });

    const post = (text: string) =>
      req(`/web/${GROUP}/message`, { method: 'POST', headers: auth(), body: JSON.stringify({ text }) });

    expect((await post('one')).status).toBe(202);
    expect((await post('two')).status).toBe(202);

    const blocked = await post('three');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'rate_limited' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Polling is not message-limited — reads continue while posts are 429ing.
    for (let i = 0; i < 5; i++) {
      expect((await req(`/web/${GROUP}/messages`, { headers: auth() })).status).toBe(200);
    }
  });

  it('honors the env overrides over the defaults', async () => {
    seedGroup();
    await startChannels({ token: TOKEN, messagesPerMin: '1' });

    const post = () =>
      req(`/web/${GROUP}/message`, { method: 'POST', headers: auth(), body: JSON.stringify({ text: 'hi' }) });

    // Default is 30/min — a limit of 1 blocking the second POST proves the
    // override took effect.
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(429);
  });

  it('leaves /health unlimited while both limiters are saturated', async () => {
    seedGroup();
    await startChannels({ token: TOKEN, authFailuresPerMin: '1', messagesPerMin: '1' });

    await req(`/web/${GROUP}/messages`, { headers: auth('bad') }); // burn auth budget
    await req(`/web/${GROUP}/message`, { method: 'POST', headers: auth(), body: JSON.stringify({ text: 'x' }) });

    for (let i = 0; i < 5; i++) {
      expect((await req('/health')).status).toBe(200);
    }
  });
});
