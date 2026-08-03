/**
 * Discord channel — trunk-shipped, dependency-free gateway adapter.
 *
 * Mirrors src/channels/telegram.ts file-for-file: hosted claws need Discord
 * without a skill install and without a public URL (a cell's preview URL
 * fronts the WEB channel; Discord interactions endpoints would need one),
 * so this adapter speaks the Gateway over an OUTBOUND websocket — as
 * hosted-friendly as Telegram's long-poll — and the REST API over `fetch`:
 *
 *   setup    → GET /users/@me (identity, the getMe equivalent), then a
 *              gateway session: HELLO → IDENTIFY → heartbeats → dispatch
 *              (MESSAGE_CREATE routes inbound)
 *   deliver  → POST /channels/{id}/messages
 *
 * Credential: DISCORD_BOT_TOKEN — created in the Discord developer portal
 * (Bot → Reset Token). Factory returns null while the token is absent; the
 * registry's startChannelAdapter starts this at runtime the moment pairing
 * (POST /web/channels/discord/pair) lands. NOTE: reading message text needs
 * the MESSAGE CONTENT privileged intent enabled on the bot (developer
 * portal → Bot → Privileged Gateway Intents); a gateway close 4013/4014 is
 * fatal and logged — the fix is in the portal, not here.
 *
 * Identity model (platform conventions used across the codebase):
 *   platform_id  `discord:<channel_id>`  (namespacedPlatformId; thread
 *                channels arrive as their own channel ids, so flat handling
 *                is honest — hence supportsThreads: false)
 *   sender       `discord:<user_id>`     via content.senderId
 *   isMention    DMs always; guild messages when the bot is in `mentions`
 *                or the message replies to the bot ('platform' signal)
 *
 * Test seams — no live Discord in the suite:
 *   DISCORD_API_BASE                    overrides the REST host
 *   setDiscordGatewaySocketFactory()    replaces the websocket constructor
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export const DISCORD_CHANNEL_TYPE = 'discord';
export const DISCORD_TOKEN_ENV_KEY = 'DISCORD_BOT_TOKEN';

const DEFAULT_API_BASE = 'https://discord.com';
const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const CALL_HTTP_TIMEOUT_MS = 15_000;
/** Backoff before reconnecting a dropped gateway — never tight-loop. */
const GATEWAY_RECONNECT_MS = 5_000;

/**
 * GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
 * MESSAGE_CONTENT is privileged — see the header note.
 */
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/** Gateway close codes that must NOT be retried: bad token (4004), sharding
 *  problems (4010–4012), and invalid/disallowed intents (4013/4014). */
const FATAL_GATEWAY_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Bot tokens: three dot-separated base64url segments (id.timestamp.hmac).
 *  Shape-checked before any network call so garbage never reaches the API. */
export const DISCORD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{4,12}\.[A-Za-z0-9_-]{20,60}$/;

/**
 * DMs engage on everything (a paired bot IS the conversation); guild
 * channels are mention-driven with platform-confirmed mentions. Unknown
 * senders go through approval — a Discord bot is world-messageable once
 * someone shares a server with it.
 */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

export function discordApiBase(): string {
  return process.env.DISCORD_API_BASE || DEFAULT_API_BASE;
}

/** Resolve the bot token (process.env first, then repo-root .env). */
export function readDiscordToken(): string {
  const file = readEnvFile([DISCORD_TOKEN_ENV_KEY]);
  return (process.env[DISCORD_TOKEN_ENV_KEY] ?? file[DISCORD_TOKEN_ENV_KEY] ?? '').trim();
}

export interface DiscordBotIdentity {
  id: string;
  username: string;
}

/** One REST call. Throws on transport failure; returns status + parsed body. */
async function callDiscord<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: T | null }> {
  const response = await fetch(`${discordApiBase()}/api/v10${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bot ${token}`, 'content-type': 'application/json' },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(CALL_HTTP_TIMEOUT_MS),
  });
  let body: T | null = null;
  try {
    body = (await response.json()) as T;
  } catch {
    // non-JSON body (204s, HTML error pages) — status carries the signal
  }
  return { status: response.status, body };
}

/**
 * Verify a token against GET /users/@me (the getMe equivalent). Three-way
 * outcome so the pairing endpoint can map precisely to its 200/400/502
 * contract:
 *   { ok: true, bot }  — token valid
 *   { ok: false, reason: 'invalid_token' }       — Discord rejected it
 *   { ok: false, reason: 'discord_unreachable' } — transport failure
 */
export async function verifyDiscordToken(
  token: string,
): Promise<{ ok: true; bot: DiscordBotIdentity } | { ok: false; reason: 'invalid_token' | 'discord_unreachable' }> {
  if (!DISCORD_TOKEN_PATTERN.test(token)) return { ok: false, reason: 'invalid_token' };
  try {
    const { status, body } = await callDiscord<{ id?: string; username?: string }>(token, '/users/@me');
    if (status !== 200 || !body?.id) return { ok: false, reason: 'invalid_token' };
    return { ok: true, bot: { id: body.id, username: body.username ?? '' } };
  } catch (err) {
    log.warn('Discord /users/@me unreachable', { err });
    return { ok: false, reason: 'discord_unreachable' };
  }
}

/** Subset of the gateway MESSAGE_CREATE shape this adapter consumes. */
export interface DiscordGatewayMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  timestamp?: string;
  author?: { id: string; username?: string; global_name?: string; bot?: boolean };
  mentions?: Array<{ id: string }>;
  referenced_message?: { author?: { id: string } } | null;
}

/** Platform-confirmed mention: bot in `mentions`, or a reply to the bot.
 *  DMs (no guild_id) are always mentions — a DM to the bot IS addressed. */
export function isMentionOfBot(message: DiscordGatewayMessage, botId: string): boolean {
  if (!message.guild_id) return true;
  if (message.mentions?.some((user) => user.id === botId)) return true;
  if (message.referenced_message?.author?.id === botId) return true;
  return false;
}

// ── Gateway session ────────────────────────────────────────────────────────

/** WHATWG-WebSocket-shaped surface the gateway session drives. Node 22's
 *  global WebSocket satisfies it; tests inject a fake via
 *  setDiscordGatewaySocketFactory. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((err: unknown) => void) | null;
}

export type GatewaySocketFactory = (url: string) => GatewaySocket;

let gatewaySocketFactory: GatewaySocketFactory | null = null;

/** Test seam: replace (or with null, restore) the websocket constructor. */
export function setDiscordGatewaySocketFactory(factory: GatewaySocketFactory | null): void {
  gatewaySocketFactory = factory;
}

function defaultSocketFactory(url: string): GatewaySocket {
  // Node ≥ 22 ships the WHATWG WebSocket client globally — no dependency.
  return new WebSocket(url) as unknown as GatewaySocket;
}

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/**
 * One resilient gateway session: connect → HELLO → IDENTIFY → heartbeat →
 * dispatch, reconnecting with backoff on any non-fatal drop. Zombie
 * detection: a heartbeat that was never ACKed closes the socket so the
 * reconnect path takes over (per the gateway docs). Fatal close codes
 * (bad token, disallowed intents) stop the session permanently — those are
 * fixed in the developer portal, and retrying would loop forever.
 */
export class DiscordGateway {
  private socket: GatewaySocket | null = null;
  private running = false;
  private ready = false;
  private fatal = false;
  private seq: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAcked = true;

  constructor(
    private readonly opts: {
      token: string;
      onMessage: (message: DiscordGatewayMessage) => void;
      gatewayUrl?: string;
      reconnectMs?: number;
    },
  ) {}

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.ready = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000);
    } catch {
      // already gone
    }
  }

  isConnected(): boolean {
    return this.ready;
  }

  /** True when the session hit a non-retryable close (portal-side fix). */
  isFatal(): boolean {
    return this.fatal;
  }

  private connect(): void {
    if (!this.running || this.fatal) return;
    const factory = gatewaySocketFactory ?? defaultSocketFactory;
    let socket: GatewaySocket;
    try {
      socket = factory(this.opts.gatewayUrl ?? DEFAULT_GATEWAY_URL);
    } catch (err) {
      log.warn('Discord gateway connect failed — backing off', { err });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onmessage = (event): void => {
      try {
        this.handlePayload(JSON.parse(String(event.data)) as GatewayPayload);
      } catch (err) {
        log.warn('Discord gateway payload unparseable — ignoring', { err });
      }
    };
    socket.onclose = (event): void => this.handleClose(event?.code);
    socket.onerror = (): void => {
      // The close event that follows carries the recovery decision.
    };
  }

  private handlePayload(payload: GatewayPayload): void {
    if (typeof payload.s === 'number') this.seq = payload.s;
    switch (payload.op) {
      case 10: {
        // HELLO — identify, then heartbeat at the server's chosen interval.
        const interval = (payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval;
        this.send({
          op: 2,
          d: {
            token: this.opts.token,
            intents: DISCORD_GATEWAY_INTENTS,
            properties: { os: 'linux', browser: 'oncellclaw', device: 'oncellclaw' },
          },
        });
        this.startHeartbeat(typeof interval === 'number' && interval > 0 ? interval : 41_250);
        break;
      }
      case 11: // HEARTBEAT ACK
        this.heartbeatAcked = true;
        break;
      case 1: // server asked for an immediate heartbeat
        this.sendHeartbeat();
        break;
      case 7: // RECONNECT
      case 9: // INVALID SESSION — either way: drop and re-identify fresh
        log.info('Discord gateway asked for a reconnect', { op: payload.op });
        try {
          this.socket?.close(4000);
        } catch {
          // close handler drives the reconnect
        }
        break;
      case 0: // DISPATCH
        if (payload.t === 'READY') {
          this.ready = true;
          log.info('Discord gateway ready');
        } else if (payload.t === 'MESSAGE_CREATE') {
          this.opts.onMessage(payload.d as DiscordGatewayMessage);
        }
        break;
      default:
        break;
    }
  }

  private handleClose(code?: number): void {
    this.ready = false;
    this.clearTimers();
    this.socket = null;
    if (code !== undefined && FATAL_GATEWAY_CLOSE_CODES.has(code)) {
      this.fatal = true;
      log.error(
        'Discord gateway closed with a non-retryable code — fix the bot in the developer portal ' +
          '(4004 bad token; 4013/4014 missing the MESSAGE CONTENT privileged intent)',
        { code },
      );
      return;
    }
    if (!this.running) return;
    log.warn('Discord gateway dropped — reconnecting', { code });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.fatal || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.opts.reconnectMs ?? GATEWAY_RECONNECT_MS);
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        // Zombie connection: the last heartbeat never got its ACK.
        log.warn('Discord gateway heartbeat unacked — recycling connection');
        try {
          this.socket?.close(4000);
        } catch {
          this.handleClose(undefined);
        }
        return;
      }
      this.sendHeartbeat();
    }, intervalMs);
  }

  private sendHeartbeat(): void {
    this.heartbeatAcked = false;
    this.send({ op: 1, d: this.seq });
  }

  private send(payload: GatewayPayload): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (err) {
      log.warn('Discord gateway send failed', { err });
    }
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

// ── Adapter ────────────────────────────────────────────────────────────────

function senderName(author: DiscordGatewayMessage['author']): string {
  if (!author) return 'unknown';
  return author.global_name || author.username || author.id;
}

function createAdapter(): ChannelAdapter | null {
  const token = readDiscordToken();
  if (!token) return null;

  let bot: DiscordBotIdentity | null = null;
  let gateway: DiscordGateway | null = null;

  function handleMessage(message: DiscordGatewayMessage, config: ChannelSetup): void {
    if (!bot || !message?.channel_id) return;
    if (message.author?.bot) return; // never route bot chatter (incl. ourselves)
    const text = message.content ?? '';
    if (!text) return; // media/embed-only events carry nothing the router can use yet

    const isGroup = Boolean(message.guild_id);
    void config.onInbound(`${DISCORD_CHANNEL_TYPE}:${message.channel_id}`, null, {
      id: `dc-${message.id}`,
      kind: 'chat',
      timestamp: message.timestamp ?? new Date().toISOString(),
      isMention: isMentionOfBot(message, bot.id),
      isGroup,
      content: {
        text,
        sender: senderName(message.author),
        senderId: message.author ? `${DISCORD_CHANNEL_TYPE}:${message.author.id}` : undefined,
      },
    });
  }

  const adapter: ChannelAdapter = {
    name: DISCORD_CHANNEL_TYPE,
    channelType: DISCORD_CHANNEL_TYPE,
    supportsThreads: false,
    defaults: DISCORD_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      const verified = await verifyDiscordToken(token);
      if (!verified.ok) {
        throw new Error(`Discord setup failed: ${verified.reason}`);
      }
      bot = verified.bot;
      gateway = new DiscordGateway({ token, onMessage: (message) => handleMessage(message, config) });
      gateway.start();
      log.info('Discord channel connecting to gateway', { bot: `@${bot.username}` });
    },

    async teardown(): Promise<void> {
      gateway?.stop();
      gateway = null;
    },

    isConnected(): boolean {
      return (gateway?.isConnected() ?? false) && bot !== null;
    },

    statusDetail(): string | undefined {
      return bot?.username ? `@${bot.username}` : undefined;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const channelId = platformId.startsWith(`${DISCORD_CHANNEL_TYPE}:`)
        ? platformId.slice(DISCORD_CHANNEL_TYPE.length + 1)
        : platformId;
      const text = extractText(message);
      if (text === null) return undefined;
      const { status, body } = await callDiscord<{ id?: string }>(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content: text },
      });
      if (status < 200 || status >= 300 || !body?.id) {
        throw new Error(`Discord message create failed: HTTP ${status}`);
      }
      return body.id;
    },
  };

  return adapter;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

registerChannelAdapter(DISCORD_CHANNEL_TYPE, {
  factory: createAdapter,
  defaults: DISCORD_DEFAULTS,
  // Same shape as Telegram: one `.env` token, no on-disk session.
  durability: { credentialKeys: [DISCORD_TOKEN_ENV_KEY] },
});
