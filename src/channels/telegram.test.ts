/**
 * Telegram adapter — token verification, mention semantics, and the
 * long-polling loop against a local Bot API stub. No live Telegram anywhere:
 * TELEGRAM_API_BASE points every call at the stub (same seam pattern as the
 * cloud-start bootstrap smoke test).
 */
import http from 'http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/oncellclaw-test-telegram/data' };
});

import type { ChannelSetup, InboundMessage } from './adapter.js';
import {
  initChannelAdapters,
  startChannelAdapter,
  stopChannelAdapter,
  teardownChannelAdapters,
} from './channel-registry.js';
import { isMentionOfBot, verifyTelegramToken, TELEGRAM_TOKEN_PATTERN } from './telegram.js';
// Self-registers the telegram factory.
import './telegram.js';

const STUB_PORT = 3957;
const GOOD_TOKEN = `123456:${'A'.repeat(35)}`;
const BOT = { id: 4242, username: 'ClawTestBot' };

interface StubState {
  getMeCalls: number;
  sends: Array<{ chat_id: number; text: string }>;
  /** Updates handed to the next getUpdates call (then cleared). */
  pendingUpdates: unknown[];
}

let stub: http.Server | null = null;
let stubState: StubState;

function startStub(): Promise<void> {
  stubState = { getMeCalls: 0, sends: [], pendingUpdates: [] };
  stub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (body: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      if (!match) {
        send({ ok: false, description: 'bad path' });
        return;
      }
      const [, token, method] = match;
      if (method === 'getMe') {
        stubState.getMeCalls += 1;
        if (token !== GOOD_TOKEN) {
          send({ ok: false, description: 'Unauthorized' });
          return;
        }
        send({ ok: true, result: BOT });
        return;
      }
      if (method === 'deleteWebhook') {
        send({ ok: true, result: true });
        return;
      }
      if (method === 'getUpdates') {
        const updates = stubState.pendingUpdates.splice(0);
        // A real Bot API holds the connection for `timeout` seconds; the stub
        // holds briefly so an empty result can't tight-loop the adapter.
        setTimeout(() => send({ ok: true, result: updates }), updates.length > 0 ? 5 : 120);
        return;
      }
      if (method === 'sendMessage') {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { chat_id: number; text: string };
        stubState.sends.push(body);
        send({ ok: true, result: { message_id: 999 } });
        return;
      }
      send({ ok: false, description: `unknown method ${method}` });
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

const noopSetup: ChannelSetup = {
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
};

beforeEach(async () => {
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${STUB_PORT}`;
  await startStub();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await stopStub();
  delete process.env.TELEGRAM_API_BASE;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('TELEGRAM_TOKEN_PATTERN', () => {
  it('accepts BotFather-shaped tokens and rejects garbage', () => {
    expect(TELEGRAM_TOKEN_PATTERN.test(GOOD_TOKEN)).toBe(true);
    expect(TELEGRAM_TOKEN_PATTERN.test('not-a-token')).toBe(false);
    expect(TELEGRAM_TOKEN_PATTERN.test('123456:short')).toBe(false);
    expect(TELEGRAM_TOKEN_PATTERN.test(`:${'A'.repeat(35)}`)).toBe(false);
  });
});

describe('verifyTelegramToken', () => {
  it('returns the bot identity for a valid token', async () => {
    const result = await verifyTelegramToken(GOOD_TOKEN);
    expect(result).toEqual({ ok: true, bot: { id: BOT.id, username: BOT.username } });
  });

  it('rejects a malformed token WITHOUT any network call', async () => {
    const result = await verifyTelegramToken('garbage');
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    expect(stubState.getMeCalls).toBe(0);
  });

  it('maps a Telegram rejection to invalid_token', async () => {
    const result = await verifyTelegramToken(`999999:${'B'.repeat(35)}`);
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('maps transport failure to telegram_unreachable', async () => {
    await stopStub();
    const result = await verifyTelegramToken(GOOD_TOKEN);
    expect(result).toEqual({ ok: false, reason: 'telegram_unreachable' });
  });
});

describe('isMentionOfBot', () => {
  const bot = { id: 4242, username: 'ClawTestBot' };
  const base = { message_id: 1, date: 0, chat: { id: 1, type: 'group' } };

  it('every private message is a mention', () => {
    expect(isMentionOfBot({ ...base, chat: { id: 1, type: 'private' }, text: 'hi' }, bot)).toBe(true);
  });

  it('matches an @BotUsername entity case-insensitively', () => {
    const text = 'hey @clawtestbot do the thing';
    const message = { ...base, text, entities: [{ type: 'mention', offset: 4, length: 12 }] };
    expect(isMentionOfBot(message, bot)).toBe(true);
  });

  it('a reply to the bot is a mention', () => {
    expect(isMentionOfBot({ ...base, text: 'yes', reply_to_message: { from: { id: bot.id } } }, bot)).toBe(true);
  });

  it('plain group chatter is not', () => {
    expect(isMentionOfBot({ ...base, text: 'morning all' }, bot)).toBe(false);
    const otherMention = { ...base, text: '@SomeoneElse hi', entities: [{ type: 'mention', offset: 0, length: 12 }] };
    expect(isMentionOfBot(otherMention, bot)).toBe(false);
  });
});

describe('long-polling adapter lifecycle', () => {
  it('starts at runtime, maps inbound updates, delivers outbound, stops cleanly', async () => {
    await initChannelAdapters(() => noopSetup); // captures the setup factory
    const inbound: Array<{ platformId: string; message: InboundMessage }> = [];
    // Re-init with a recording setup by starting the channel at runtime.
    process.env.TELEGRAM_BOT_TOKEN = GOOD_TOKEN;
    await teardownChannelAdapters();
    await initChannelAdapters(() => ({
      ...noopSetup,
      onInbound: (platformId: string, _threadId: string | null, message: InboundMessage) => {
        inbound.push({ platformId, message });
      },
    }));

    const adapter = await startChannelAdapter('telegram');
    expect(adapter).not.toBeNull();
    expect(adapter!.isConnected()).toBe(true);
    expect(adapter!.statusDetail?.()).toBe('@ClawTestBot');

    stubState.pendingUpdates.push({
      update_id: 7,
      message: {
        message_id: 100,
        date: 1_700_000_000,
        text: 'hello claw',
        chat: { id: 555, type: 'private' },
        from: { id: 888, first_name: 'Anup' },
      },
    });

    await vi.waitFor(() => expect(inbound.length).toBe(1), { timeout: 5000 });
    expect(inbound[0]!.platformId).toBe('telegram:555');
    expect(inbound[0]!.message.isMention).toBe(true);
    expect(inbound[0]!.message.isGroup).toBe(false);
    expect(inbound[0]!.message.content).toMatchObject({
      text: 'hello claw',
      sender: 'Anup',
      senderId: 'telegram:888',
    });

    const platformMsgId = await adapter!.deliver('telegram:555', null, {
      kind: 'chat',
      content: { text: 'hi Anup' },
    });
    expect(platformMsgId).toBe('999');
    expect(stubState.sends).toEqual([{ chat_id: 555, text: 'hi Anup' }]);

    await stopChannelAdapter('telegram');
    expect(adapter!.isConnected()).toBe(false);
  });

  it('factory declines while TELEGRAM_BOT_TOKEN is absent', async () => {
    await initChannelAdapters(() => noopSetup);
    delete process.env.TELEGRAM_BOT_TOKEN;
    const adapter = await startChannelAdapter('telegram');
    expect(adapter).toBeNull();
  });
});
