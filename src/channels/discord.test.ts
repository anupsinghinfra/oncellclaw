/**
 * Discord adapter — token verification, mention semantics, the gateway
 * protocol state machine, and the adapter lifecycle against local stubs.
 * No live Discord anywhere: DISCORD_API_BASE points REST at an http stub
 * (same seam pattern as TELEGRAM_API_BASE) and the gateway websocket is a
 * fake injected via setDiscordGatewaySocketFactory.
 */
import http from 'http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/oncellclaw-test-discord/data' };
});

import type { ChannelSetup, InboundMessage } from './adapter.js';
import {
  initChannelAdapters,
  startChannelAdapter,
  stopChannelAdapter,
  teardownChannelAdapters,
} from './channel-registry.js';
import {
  DiscordGateway,
  DISCORD_GATEWAY_INTENTS,
  DISCORD_TOKEN_PATTERN,
  isMentionOfBot,
  setDiscordGatewaySocketFactory,
  verifyDiscordToken,
  type DiscordGatewayMessage,
  type GatewaySocket,
} from './discord.js';
// Self-registers the discord factory.
import './discord.js';

const STUB_PORT = 3959;
const GOOD_TOKEN = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(27)}`;
const BOT = { id: '424242', username: 'ClawTestBot' };

interface StubState {
  meCalls: number;
  sends: Array<{ channelId: string; content: string }>;
}

let stub: http.Server | null = null;
let stubState: StubState;

function startStub(): Promise<void> {
  stubState = { meCalls: 0, sends: [] };
  stub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const auth = req.headers.authorization ?? '';
      if (req.url === '/api/v10/users/@me') {
        stubState.meCalls += 1;
        if (auth !== `Bot ${GOOD_TOKEN}`) {
          send(401, { message: '401: Unauthorized' });
          return;
        }
        send(200, BOT);
        return;
      }
      const match = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(req.url ?? '');
      if (match && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { content: string };
        stubState.sends.push({ channelId: match[1]!, content: body.content });
        send(200, { id: '999' });
        return;
      }
      send(404, { message: 'not found' });
    });
  });
  return new Promise((resolve) => stub!.listen(STUB_PORT, '127.0.0.1', resolve));
}

function stopStub(): Promise<void> {
  return new Promise((resolve) => {
    if (!stub) return resolve();
    stub.close(() => resolve());
    stub = null;
  });
}

/** In-memory gateway socket the tests drive by hand. */
class FakeSocket implements GatewaySocket {
  sent: Array<{ op: number; d?: unknown }> = [];
  closed: number | undefined | null = null; // null = still open
  /** ACK every heartbeat immediately (keeps the zombie detector quiet). */
  autoAckHeartbeats = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  send(data: string): void {
    const payload = JSON.parse(data) as { op: number; d?: unknown };
    this.sent.push(payload);
    if (payload.op === 1 && this.autoAckHeartbeats) {
      queueMicrotask(() => this.receive({ op: 11 }));
    }
  }

  close(code?: number): void {
    if (this.closed !== null) return;
    this.closed = code;
    this.onclose?.({ code });
  }

  /** Server-side push. */
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** Server-side close (e.g. a fatal close code). */
  dropWithCode(code: number): void {
    this.closed = code;
    this.onclose?.({ code });
  }
}

const noopSetup: ChannelSetup = {
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
};

beforeEach(async () => {
  process.env.DISCORD_API_BASE = `http://127.0.0.1:${STUB_PORT}`;
  await startStub();
});

afterEach(async () => {
  await teardownChannelAdapters();
  setDiscordGatewaySocketFactory(null);
  await stopStub();
  delete process.env.DISCORD_API_BASE;
  delete process.env.DISCORD_BOT_TOKEN;
});

describe('DISCORD_TOKEN_PATTERN', () => {
  it('accepts portal-shaped tokens and rejects garbage', () => {
    expect(DISCORD_TOKEN_PATTERN.test(GOOD_TOKEN)).toBe(true);
    expect(DISCORD_TOKEN_PATTERN.test('not-a-token')).toBe(false);
    expect(DISCORD_TOKEN_PATTERN.test('two.parts')).toBe(false);
    expect(DISCORD_TOKEN_PATTERN.test('a.b.c')).toBe(false);
    // Telegram-shaped tokens must not pass as Discord tokens.
    expect(DISCORD_TOKEN_PATTERN.test(`123456:${'A'.repeat(35)}`)).toBe(false);
  });
});

describe('verifyDiscordToken', () => {
  it('returns the bot identity for a valid token', async () => {
    const result = await verifyDiscordToken(GOOD_TOKEN);
    expect(result).toEqual({ ok: true, bot: { id: BOT.id, username: BOT.username } });
  });

  it('rejects a malformed token WITHOUT any network call', async () => {
    const result = await verifyDiscordToken('garbage');
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    expect(stubState.meCalls).toBe(0);
  });

  it('maps a Discord 401 to invalid_token', async () => {
    const result = await verifyDiscordToken(`${'X'.repeat(24)}.${'Y'.repeat(6)}.${'Z'.repeat(27)}`);
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    expect(stubState.meCalls).toBe(1);
  });

  it('maps transport failure to discord_unreachable', async () => {
    await stopStub();
    const result = await verifyDiscordToken(GOOD_TOKEN);
    expect(result).toEqual({ ok: false, reason: 'discord_unreachable' });
  });
});

describe('isMentionOfBot', () => {
  const base: DiscordGatewayMessage = { id: '1', channel_id: 'c1', guild_id: 'g1', content: 'hi' };

  it('every DM (no guild_id) is a mention', () => {
    expect(isMentionOfBot({ ...base, guild_id: undefined }, BOT.id)).toBe(true);
  });

  it('a guild message mentioning the bot is a mention', () => {
    expect(isMentionOfBot({ ...base, mentions: [{ id: BOT.id }] }, BOT.id)).toBe(true);
  });

  it('a reply to the bot is a mention', () => {
    expect(isMentionOfBot({ ...base, referenced_message: { author: { id: BOT.id } } }, BOT.id)).toBe(true);
  });

  it('plain guild chatter is not', () => {
    expect(isMentionOfBot(base, BOT.id)).toBe(false);
    expect(isMentionOfBot({ ...base, mentions: [{ id: 'someone-else' }] }, BOT.id)).toBe(false);
  });
});

describe('DiscordGateway protocol', () => {
  function startGateway(opts?: { reconnectMs?: number; autoAck?: boolean }) {
    const sockets: FakeSocket[] = [];
    setDiscordGatewaySocketFactory(() => {
      const socket = new FakeSocket();
      socket.autoAckHeartbeats = opts?.autoAck ?? false;
      sockets.push(socket);
      return socket;
    });
    const messages: DiscordGatewayMessage[] = [];
    const gateway = new DiscordGateway({
      token: GOOD_TOKEN,
      onMessage: (m) => messages.push(m),
      reconnectMs: opts?.reconnectMs ?? 10,
    });
    gateway.start();
    return { gateway, sockets, messages };
  }

  it('identifies on HELLO with token and intents, heartbeats at the interval', async () => {
    const { gateway, sockets } = startGateway({ autoAck: true });
    const socket = sockets[0]!;
    socket.receive({ op: 10, d: { heartbeat_interval: 15 } });

    const identify = socket.sent.find((p) => p.op === 2);
    expect(identify).toBeDefined();
    expect(identify!.d).toMatchObject({ token: GOOD_TOKEN, intents: DISCORD_GATEWAY_INTENTS });

    // Heartbeats tick at the server-chosen interval (auto-ACKed by the fake
    // so the zombie detector stays quiet).
    await vi.waitFor(() => expect(socket.sent.filter((p) => p.op === 1).length).toBeGreaterThanOrEqual(2));
    gateway.stop();
  });

  it('READY flips isConnected, MESSAGE_CREATE dispatches, seq rides heartbeats', () => {
    const { gateway, sockets, messages } = startGateway();
    const socket = sockets[0]!;
    socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    expect(gateway.isConnected()).toBe(false);

    socket.receive({ op: 0, s: 1, t: 'READY', d: { session_id: 's' } });
    expect(gateway.isConnected()).toBe(true);

    socket.receive({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: 'm1', channel_id: 'c1', content: 'hello' } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'm1', channel_id: 'c1' });

    // A server-requested heartbeat carries the last seen sequence number.
    socket.receive({ op: 1 });
    const beat = socket.sent.filter((p) => p.op === 1).at(-1)!;
    expect(beat.d).toBe(2);
    gateway.stop();
  });

  it('reconnects with a fresh socket on RECONNECT and on a normal drop', async () => {
    const { gateway, sockets } = startGateway({ reconnectMs: 5 });
    sockets[0]!.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    sockets[0]!.receive({ op: 0, s: 1, t: 'READY', d: {} });
    expect(gateway.isConnected()).toBe(true);

    sockets[0]!.receive({ op: 7 }); // server: reconnect
    expect(gateway.isConnected()).toBe(false);
    await vi.waitFor(() => expect(sockets.length).toBe(2));

    // The fresh session identifies again from scratch.
    sockets[1]!.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    expect(sockets[1]!.sent.some((p) => p.op === 2)).toBe(true);
    gateway.stop();
  });

  it('a fatal close code (bad token / missing intent) stops reconnecting', async () => {
    const { gateway, sockets } = startGateway({ reconnectMs: 5 });
    sockets[0]!.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    sockets[0]!.dropWithCode(4014); // disallowed intents

    expect(gateway.isFatal()).toBe(true);
    // Give the (wrongly scheduled, if any) reconnect a chance to fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(sockets.length).toBe(1);
    gateway.stop();
  });

  it('an unacked heartbeat recycles the connection (zombie detection)', async () => {
    const { gateway, sockets } = startGateway({ reconnectMs: 5 });
    const socket = sockets[0]!;
    socket.receive({ op: 10, d: { heartbeat_interval: 15 } });
    // Never ACK: first tick sends a heartbeat, second tick sees it unacked
    // and closes → reconnect path spins up a new socket.
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    expect(socket.closed).toBe(4000);
    gateway.stop();
  });
});

describe('gateway adapter lifecycle', () => {
  it('starts at runtime, maps inbound MESSAGE_CREATE, delivers outbound, stops cleanly', async () => {
    const sockets: FakeSocket[] = [];
    setDiscordGatewaySocketFactory(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });

    const inbound: Array<{ platformId: string; message: InboundMessage }> = [];
    // Init WITHOUT the token (factory declines), then pair at runtime — the
    // same path POST /web/channels/discord/pair takes.
    await initChannelAdapters(() => ({
      ...noopSetup,
      onInbound: (platformId: string, _threadId: string | null, message: InboundMessage) => {
        inbound.push({ platformId, message });
      },
    }));
    process.env.DISCORD_BOT_TOKEN = GOOD_TOKEN;

    const adapter = await startChannelAdapter('discord');
    expect(adapter).not.toBeNull();
    expect(adapter!.statusDetail?.()).toBe('@ClawTestBot');

    // Complete the gateway handshake on the fake socket.
    const socket = sockets[0]!;
    socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    socket.receive({ op: 0, s: 1, t: 'READY', d: {} });
    expect(adapter!.isConnected()).toBe(true);

    // A guild message from a human, mentioning the bot.
    socket.receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: {
        id: '100',
        channel_id: '555',
        guild_id: 'g1',
        content: 'hello claw',
        timestamp: '2026-08-04T10:00:00.000Z',
        author: { id: '888', username: 'anup', global_name: 'Anup' },
        mentions: [{ id: BOT.id }],
      },
    });
    await vi.waitFor(() => expect(inbound.length).toBe(1));
    expect(inbound[0]!.platformId).toBe('discord:555');
    expect(inbound[0]!.message.isMention).toBe(true);
    expect(inbound[0]!.message.isGroup).toBe(true);
    expect(inbound[0]!.message.content).toMatchObject({
      text: 'hello claw',
      sender: 'Anup',
      senderId: 'discord:888',
    });

    // Bot chatter and empty content never route.
    socket.receive({
      op: 0,
      s: 3,
      t: 'MESSAGE_CREATE',
      d: { id: '101', channel_id: '555', content: 'beep', author: { id: '1', bot: true } },
    });
    socket.receive({
      op: 0,
      s: 4,
      t: 'MESSAGE_CREATE',
      d: { id: '102', channel_id: '555', content: '', author: { id: '888' } },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(inbound.length).toBe(1);

    const platformMsgId = await adapter!.deliver('discord:555', null, { kind: 'chat', content: { text: 'hi Anup' } });
    expect(platformMsgId).toBe('999');
    expect(stubState.sends).toEqual([{ channelId: '555', content: 'hi Anup' }]);

    await stopChannelAdapter('discord');
    expect(adapter!.isConnected()).toBe(false);
  });

  it('factory declines while DISCORD_BOT_TOKEN is absent', async () => {
    await initChannelAdapters(() => noopSetup);
    delete process.env.DISCORD_BOT_TOKEN;
    const adapter = await startChannelAdapter('discord');
    expect(adapter).toBeNull();
  });

  it('setup fails loudly when Discord rejects the token', async () => {
    await initChannelAdapters(() => noopSetup);
    process.env.DISCORD_BOT_TOKEN = `${'X'.repeat(24)}.${'Y'.repeat(6)}.${'Z'.repeat(27)}`;
    await expect(startChannelAdapter('discord')).rejects.toThrow(/invalid_token/);
  });
});
