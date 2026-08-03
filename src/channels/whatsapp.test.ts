/**
 * WhatsApp adapter — the trunk lifecycle, the shared/dedicated split, and
 * the persistence that makes a scan survive an update.
 *
 * No Baileys and no WhatsApp anywhere: the socket is a hand-driven fake
 * injected through setWhatsappSocketFactory (the same seam pattern as
 * discord's setDiscordGatewaySocketFactory), and the linked-device session is
 * a `creds.json` in a temp dir pointed at by ONCELLCLAW_WA_AUTH_DIR.
 *
 * The product claim under test is narrow and load-bearing: a hosted claw
 * re-extracts a pristine trunk tarball on every deploy, so WhatsApp has to be
 * a channel you CONFIGURE (session on disk under a durable path, adapter
 * already in the tree) rather than one you INSTALL. Everything here is a
 * consequence of that — the factory keys on the session file, the session
 * path resolves inside `store/`, and the registry starts the adapter the
 * moment the session appears without a process restart.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import {
  getChannelAdapterExact,
  initChannelAdapters,
  startChannelAdapter,
  teardownChannelAdapters,
} from './channel-registry.js';
import { isDurablePath } from '../durable-state.js';
import { WHATSAPP_AUTH_SUBPATH, normalizeJid, phoneFromJid, whatsappAuthDir } from './whatsapp-session.js';
import {
  WHATSAPP_CHANNEL_TYPE,
  assistantName,
  extractInboundText,
  hasOwnNumber,
  inboundTimestamp,
  isMentionOfBot,
  setWhatsappSocketFactory,
  whatsappChannelDefaults,
  type WhatsappConnection,
  type WhatsappConnectionUpdate,
  type WhatsappIncomingMessage,
  type WhatsappMessageUpsert,
  type WhatsappSocket,
} from './whatsapp.js';
// Self-registers the whatsapp factory.
import './whatsapp.js';

const BOT_PHONE = '15550001111';
const BOT_JID = `${BOT_PHONE}@s.whatsapp.net`;
const HUMAN_JID = '15559998888@s.whatsapp.net';
const GROUP_JID = '120363000000000000@g.us';

// ── The fake socket ────────────────────────────────────────────────────────

/** In-memory Baileys socket the tests drive by hand. */
class FakeSocket implements WhatsappSocket {
  user: { id?: string | null } | null = { id: `${BOT_PHONE}:12@s.whatsapp.net` };
  sends: Array<{ jid: string; text: string }> = [];
  presence: Array<{ type: string; jid?: string }> = [];
  ended = false;
  /** Message id the next sendMessage resolves with. */
  nextSendId = 'sent-1';

  private listeners = new Map<string, Array<(payload: never) => void>>();

  ev = {
    on: <K extends 'connection.update' | 'messages.upsert' | 'creds.update'>(
      event: K,
      listener: (payload: never) => void,
    ): void => {
      const existing = this.listeners.get(event) ?? [];
      this.listeners.set(event, [...existing, listener]);
    },
  };

  async sendMessage(jid: string, content: { text: string }): Promise<{ key: { id: string } }> {
    this.sends.push({ jid, text: content.text });
    return { key: { id: this.nextSendId } };
  }

  async sendPresenceUpdate(type: string, jid?: string): Promise<void> {
    this.presence.push({ type, jid });
  }

  end(): void {
    this.ended = true;
  }

  // ── server-side pushes ──
  open(): void {
    this.emit('connection.update', { connection: 'open' } satisfies WhatsappConnectionUpdate);
  }

  close(statusCode?: number): void {
    this.emit('connection.update', {
      connection: 'close',
      lastDisconnect: statusCode === undefined ? null : { error: { output: { statusCode } } },
    } satisfies WhatsappConnectionUpdate);
  }

  deliver(messages: WhatsappIncomingMessage[], type = 'notify'): void {
    this.emit('messages.upsert', { type, messages } satisfies WhatsappMessageUpsert);
  }

  credsUpdate(): void {
    this.emit('creds.update', undefined as never);
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (p: unknown) => void)(payload);
    }
  }
}

// ── Harness ────────────────────────────────────────────────────────────────

let tmp: string;
let authDir: string;
let sockets: FakeSocket[];
let saveCredsCalls: number;
let factoryAuthDirs: string[];
let inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }>;

/** A session on disk = a paired install. This is the whole credential. */
function writeSession(): void {
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify({ me: { id: `${BOT_PHONE}:12@s.whatsapp.net` } }));
}

function installFakeFactory(): void {
  setWhatsappSocketFactory(async ({ authDir: dir }): Promise<WhatsappConnection> => {
    factoryAuthDirs.push(dir);
    const socket = new FakeSocket();
    sockets.push(socket);
    return {
      socket,
      saveCreds: (): void => {
        saveCredsCalls += 1;
      },
    };
  });
}

function setupFn(): ChannelSetup {
  return {
    onInbound: (platformId, threadId, message) => {
      inbound.push({ platformId, threadId, message });
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
}

/** Boot the registry and return the live adapter (or undefined). */
async function boot(): Promise<ChannelAdapter | undefined> {
  await initChannelAdapters(setupFn);
  return getChannelAdapterExact(WHATSAPP_CHANNEL_TYPE);
}

const lastSocket = (): FakeSocket => sockets[sockets.length - 1]!;

function textMessage(
  over: Partial<WhatsappIncomingMessage> & { key: WhatsappIncomingMessage['key'] },
): WhatsappIncomingMessage {
  return {
    message: { conversation: 'hello' },
    pushName: 'Ada',
    messageTimestamp: 1_700_000_000,
    ...over,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-adapter-'));
  authDir = path.join(tmp, 'store', 'auth');
  sockets = [];
  saveCredsCalls = 0;
  factoryAuthDirs = [];
  inbound = [];
  process.env.ONCELLCLAW_WA_AUTH_DIR = authDir;
  // Explicit rather than absent: a developer's real .env must not decide
  // which number mode these tests run in.
  process.env.ASSISTANT_HAS_OWN_NUMBER = 'false';
  process.env.ASSISTANT_NAME = 'Nano';
  installFakeFactory();
});

afterEach(async () => {
  await teardownChannelAdapters();
  setWhatsappSocketFactory(null);
  delete process.env.ONCELLCLAW_WA_AUTH_DIR;
  delete process.env.ASSISTANT_HAS_OWN_NUMBER;
  delete process.env.ASSISTANT_NAME;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Session location: the reason any of this survives an update ────────────

describe('whatsapp — session location', () => {
  it('defaults to store/auth, which is a path cloud-start keeps', () => {
    delete process.env.ONCELLCLAW_WA_AUTH_DIR;
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);

    expect(whatsappAuthDir()).toBe(path.join(tmp, 'store', 'auth'));
    expect(isDurablePath(WHATSAPP_AUTH_SUBPATH, tmp)).toBe(true);
    expect(isDurablePath(whatsappAuthDir(), tmp)).toBe(true);
  });

  it('is the directory the adapter hands its socket factory', async () => {
    writeSession();
    await boot();
    expect(factoryAuthDirs).toEqual([authDir]);
  });

  it('rewrites the session through saveCreds as Baileys rotates keys', async () => {
    writeSession();
    await boot();

    lastSocket().credsUpdate();
    lastSocket().credsUpdate();

    // Each rotation is written back under store/ — that write IS what makes
    // a pairing outlive the next deploy.
    expect(saveCredsCalls).toBe(2);
  });

  it('strips the device suffix so one human is one user id across relinks', () => {
    expect(normalizeJid(`${BOT_PHONE}:12@s.whatsapp.net`)).toBe(BOT_JID);
    expect(normalizeJid(`${BOT_PHONE}:99@s.whatsapp.net`)).toBe(BOT_JID);
    expect(normalizeJid(GROUP_JID)).toBe(GROUP_JID);
    expect(phoneFromJid(`${BOT_PHONE}:12@s.whatsapp.net`)).toBe(BOT_PHONE);
  });
});

// ── Factory gating: the session IS the credential ──────────────────────────

describe('whatsapp — factory gating', () => {
  it('stays dormant with no session on disk', async () => {
    expect(await boot()).toBeUndefined();
    expect(sockets).toHaveLength(0);
  });

  it('starts once a session exists', async () => {
    writeSession();
    const adapter = await boot();

    expect(adapter?.channelType).toBe(WHATSAPP_CHANNEL_TYPE);
    expect(adapter?.supportsThreads).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  /**
   * The pairing path: the process booted unpaired, a QR was scanned, and the
   * relay calls startChannelAdapter. No restart may be required — that is the
   * difference between "paired" and "paired and actually reachable".
   */
  it('comes up at runtime when a scan lands mid-process', async () => {
    expect(await boot()).toBeUndefined();

    writeSession();
    const adapter = await startChannelAdapter(WHATSAPP_CHANNEL_TYPE);

    expect(adapter).not.toBeNull();
    expect(getChannelAdapterExact(WHATSAPP_CHANNEL_TYPE)).toBe(adapter);
    expect(sockets).toHaveLength(1);
  });
});

// ── Number mode ────────────────────────────────────────────────────────────

describe('whatsapp — shared vs dedicated number', () => {
  it('reads an absent flag as shared — the safe default', () => {
    delete process.env.ASSISTANT_HAS_OWN_NUMBER;
    vi.spyOn(process, 'cwd').mockReturnValue(tmp); // no .env in the scratch root
    expect(hasOwnNumber()).toBe(false);
    expect(whatsappChannelDefaults().mentions).toBe('never');
  });

  it('reads anything other than "true" as shared', () => {
    for (const value of ['false', '', 'TRUE', 'yes', '1']) {
      process.env.ASSISTANT_HAS_OWN_NUMBER = value;
      expect(hasOwnNumber()).toBe(false);
    }
  });

  it('declares name-pattern group engagement and strict senders when shared', () => {
    const defaults = whatsappChannelDefaults();
    expect(defaults.mentions).toBe('never');
    expect(defaults.group).toMatchObject({ engageMode: 'pattern', engagePattern: '\\b{name}\\b' });
    expect(defaults.dm.unknownSenderPolicy).toBe('strict');
    expect(defaults.group.unknownSenderPolicy).toBe('strict');
  });

  it('declares platform mentions and approval cards when dedicated', () => {
    process.env.ASSISTANT_HAS_OWN_NUMBER = 'true';
    const defaults = whatsappChannelDefaults();
    expect(defaults.mentions).toBe('platform');
    expect(defaults.group.engageMode).toBe('mention');
    expect(defaults.dm.unknownSenderPolicy).toBe('request_approval');
  });

  it('never declares threads — WhatsApp chats are flat', () => {
    for (const value of ['true', 'false']) {
      process.env.ASSISTANT_HAS_OWN_NUMBER = value;
      const defaults = whatsappChannelDefaults();
      expect(defaults.dm.threads).toBe(false);
      expect(defaults.group.threads).toBe(false);
    }
  });

  it('falls back to the stock assistant name', () => {
    delete process.env.ASSISTANT_NAME;
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    expect(assistantName()).toBe('Andy');
  });
});

// ── Inbound routing ────────────────────────────────────────────────────────

describe('whatsapp — inbound routing', () => {
  it('routes a DM with the JID as the platform id and no thread', async () => {
    writeSession();
    await boot();
    lastSocket().open();

    lastSocket().deliver([textMessage({ key: { remoteJid: HUMAN_JID, fromMe: false, id: 'm1' } })]);

    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.platformId).toBe(HUMAN_JID); // native adapter: no `whatsapp:` prefix
    expect(inbound[0]!.threadId).toBeNull();
    expect(inbound[0]!.message.isGroup).toBe(false);
    expect(inbound[0]!.message.content).toMatchObject({ text: 'hello', sender: 'Ada', senderId: HUMAN_JID });
  });

  it('routes a group message and attributes it to the participant', async () => {
    writeSession();
    await boot();
    lastSocket().open();

    lastSocket().deliver([
      textMessage({
        key: {
          remoteJid: GROUP_JID,
          fromMe: false,
          id: 'm2',
          participant: `${HUMAN_JID.split('@')[0]}:7@s.whatsapp.net`,
        },
      }),
    ]);

    expect(inbound[0]!.platformId).toBe(GROUP_JID);
    expect(inbound[0]!.message.isGroup).toBe(true);
    // Device suffix stripped: a colon in the handle would read as an
    // already-namespaced user id downstream (permissions/index.ts).
    expect((inbound[0]!.message.content as { senderId: string }).senderId).toBe(HUMAN_JID);
  });

  it('ignores history backfill — replaying it would answer old messages', async () => {
    writeSession();
    await boot();
    lastSocket().open();

    lastSocket().deliver([textMessage({ key: { remoteJid: HUMAN_JID, fromMe: false, id: 'm3' } })], 'append');

    expect(inbound).toHaveLength(0);
  });

  it('ignores status broadcasts and text-less media', async () => {
    writeSession();
    await boot();
    lastSocket().open();

    lastSocket().deliver([
      textMessage({ key: { remoteJid: 'status@broadcast', fromMe: false, id: 'm4' } }),
      { key: { remoteJid: HUMAN_JID, fromMe: false, id: 'm5' }, message: { imageMessage: { caption: null } } },
    ]);

    expect(inbound).toHaveLength(0);
  });

  it('reads text out of captions and extended text alike', () => {
    expect(extractInboundText({ key: {}, message: { conversation: 'plain' } })).toBe('plain');
    expect(extractInboundText({ key: {}, message: { extendedTextMessage: { text: 'quoted' } } })).toBe('quoted');
    expect(extractInboundText({ key: {}, message: { imageMessage: { caption: 'photo' } } })).toBe('photo');
    expect(extractInboundText({ key: {}, message: { videoMessage: { caption: 'clip' } } })).toBe('clip');
    expect(extractInboundText({ key: {}, message: null })).toBe('');
  });

  it('accepts Baileys timestamps as number, string or protobuf Long', () => {
    expect(inboundTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(inboundTimestamp('1700000000')).toBe('2023-11-14T22:13:20.000Z');
    expect(inboundTimestamp({ toNumber: () => 1_700_000_000 })).toBe('2023-11-14T22:13:20.000Z');
    // Garbage falls back to "now" rather than 1970.
    expect(new Date(inboundTimestamp(null)).getUTCFullYear()).toBeGreaterThan(2020);
  });
});

// ── fromMe: the whole shared-number design ─────────────────────────────────

describe('whatsapp — fromMe handling', () => {
  it('routes the operator self-chat on a shared number', async () => {
    writeSession();
    await boot();
    lastSocket().open();

    // On a personal number the operator's own "You" chat IS the agent's
    // inbox, and every message in it is fromMe. Dropping them mutes the
    // channel entirely.
    lastSocket().deliver([textMessage({ key: { remoteJid: BOT_JID, fromMe: true, id: 'self-1' } })]);

    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.platformId).toBe(BOT_JID);
  });

  it('ignores fromMe traffic in other chats on a shared number', async () => {
    writeSession();
    await boot();
    lastSocket().open();

    lastSocket().deliver([textMessage({ key: { remoteJid: HUMAN_JID, fromMe: true, id: 'own-1' } })]);

    expect(inbound).toHaveLength(0);
  });

  it('ignores everything fromMe on a dedicated number', async () => {
    process.env.ASSISTANT_HAS_OWN_NUMBER = 'true';
    writeSession();
    await boot();
    lastSocket().open();

    lastSocket().deliver([textMessage({ key: { remoteJid: BOT_JID, fromMe: true, id: 'self-2' } })]);

    expect(inbound).toHaveLength(0);
  });

  it('never routes the echo of a reply it just sent', async () => {
    writeSession();
    const adapter = await boot();
    lastSocket().open();
    lastSocket().nextSendId = 'echo-me';

    await adapter!.deliver(BOT_JID, null, { kind: 'chat', content: { text: 'answering' } });
    lastSocket().deliver([textMessage({ key: { remoteJid: BOT_JID, fromMe: true, id: 'echo-me' } })]);

    // Without the sent-id memory this is an infinite self-conversation.
    expect(inbound).toHaveLength(0);
  });
});

// ── Mentions ───────────────────────────────────────────────────────────────

describe('whatsapp — mention semantics', () => {
  it('treats every DM as addressed, and a group message only when tagged', () => {
    expect(isMentionOfBot({ key: { remoteJid: HUMAN_JID } }, BOT_JID)).toBe(true);
    expect(isMentionOfBot({ key: { remoteJid: GROUP_JID } }, BOT_JID)).toBe(false);
    expect(
      isMentionOfBot(
        {
          key: { remoteJid: GROUP_JID },
          message: { extendedTextMessage: { text: '@bot hi', contextInfo: { mentionedJid: [BOT_JID] } } },
        },
        BOT_JID,
      ),
    ).toBe(true);
    // A reply to one of the bot's messages counts too.
    expect(
      isMentionOfBot(
        {
          key: { remoteJid: GROUP_JID },
          message: {
            extendedTextMessage: { text: 'yes', contextInfo: { participant: `${BOT_PHONE}:3@s.whatsapp.net` } },
          },
        },
        BOT_JID,
      ),
    ).toBe(true);
  });

  it('emits no mention signal at all on a shared number', async () => {
    writeSession();
    await boot();
    lastSocket().open();

    lastSocket().deliver([textMessage({ key: { remoteJid: HUMAN_JID, fromMe: false, id: 'm6' } })]);

    // `mentions: 'never'` — a stranger's DM must not auto-create a group or
    // raise an approval card on someone's personal line.
    expect(inbound[0]!.message.isMention).toBeUndefined();
  });

  it('emits the platform mention signal on a dedicated number', async () => {
    process.env.ASSISTANT_HAS_OWN_NUMBER = 'true';
    writeSession();
    await boot();
    lastSocket().open();

    lastSocket().deliver([
      textMessage({ key: { remoteJid: HUMAN_JID, fromMe: false, id: 'm7' } }),
      textMessage({ key: { remoteJid: GROUP_JID, fromMe: false, id: 'm8', participant: HUMAN_JID } }),
    ]);

    expect(inbound[0]!.message.isMention).toBe(true); // DM
    expect(inbound[1]!.message.isMention).toBe(false); // untagged group chatter
  });
});

// ── Outbound ───────────────────────────────────────────────────────────────

describe('whatsapp — delivery', () => {
  it('prefixes the assistant name on a shared number', async () => {
    writeSession();
    const adapter = await boot();
    lastSocket().open();

    const id = await adapter!.deliver(HUMAN_JID, null, { kind: 'chat', content: { text: 'done' } });

    expect(lastSocket().sends).toEqual([{ jid: HUMAN_JID, text: 'Nano: done' }]);
    expect(id).toBe('sent-1');
  });

  it('sends bare text on a dedicated number', async () => {
    process.env.ASSISTANT_HAS_OWN_NUMBER = 'true';
    writeSession();
    const adapter = await boot();
    lastSocket().open();

    await adapter!.deliver(HUMAN_JID, null, { kind: 'chat', content: { text: 'done' } });

    expect(lastSocket().sends).toEqual([{ jid: HUMAN_JID, text: 'done' }]);
  });

  it('accepts a string content payload and strips a stray whatsapp: prefix', async () => {
    process.env.ASSISTANT_HAS_OWN_NUMBER = 'true';
    writeSession();
    const adapter = await boot();
    lastSocket().open();

    await adapter!.deliver(`whatsapp:${HUMAN_JID}`, null, { kind: 'chat', content: 'raw' });

    expect(lastSocket().sends).toEqual([{ jid: HUMAN_JID, text: 'raw' }]);
  });

  it('sends nothing for a payload with no text', async () => {
    writeSession();
    const adapter = await boot();
    lastSocket().open();

    expect(await adapter!.deliver(HUMAN_JID, null, { kind: 'chat', content: { blocks: [] } })).toBeUndefined();
    expect(lastSocket().sends).toHaveLength(0);
  });

  it('reports composing presence', async () => {
    writeSession();
    const adapter = await boot();
    lastSocket().open();

    await adapter!.setTyping!(HUMAN_JID, null);

    expect(lastSocket().presence).toEqual([{ type: 'composing', jid: HUMAN_JID }]);
  });

  it('throws rather than silently dropping when the socket is gone', async () => {
    writeSession();
    const adapter = await boot();
    await adapter!.teardown();

    await expect(adapter!.deliver(HUMAN_JID, null, { kind: 'chat', content: { text: 'x' } })).rejects.toThrow(
      /not connected/,
    );
  });
});

// ── Connection lifecycle ───────────────────────────────────────────────────

describe('whatsapp — connection lifecycle', () => {
  it('reports connected only between open and close', async () => {
    writeSession();
    const adapter = await boot();

    expect(adapter!.isConnected()).toBe(false);
    lastSocket().open();
    expect(adapter!.isConnected()).toBe(true);
    lastSocket().close(500);
    expect(adapter!.isConnected()).toBe(false);
  });

  it('surfaces the linked number and the mode in status detail', async () => {
    writeSession();
    const adapter = await boot();
    lastSocket().open();

    expect(adapter!.statusDetail!()).toBe(`+${BOT_PHONE} (shared number)`);
  });

  it('reconnects after a transient drop', async () => {
    vi.useFakeTimers();
    try {
      writeSession();
      await boot();
      lastSocket().open();

      lastSocket().close(500);
      await vi.advanceTimersByTimeAsync(6_000);

      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect after the phone unlinks the device', async () => {
    vi.useFakeTimers();
    try {
      writeSession();
      await boot();
      lastSocket().open();

      // 401 = logged out. The saved session is dead; retrying can only fail,
      // and the fix is a fresh QR scan.
      lastSocket().close(401);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the socket and stops reconnecting on teardown', async () => {
    vi.useFakeTimers();
    try {
      writeSession();
      const adapter = await boot();
      lastSocket().open();
      const socket = lastSocket();

      await adapter!.teardown();
      socket.close(500);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(socket.ended).toBe(true);
      expect(sockets).toHaveLength(1);
      expect(adapter!.isConnected()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
