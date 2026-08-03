/**
 * Telegram channel — trunk-shipped, dependency-free long-polling adapter.
 *
 * Hosted claws need Telegram without a skill install and without a public
 * webhook (a cell's preview URL fronts the WEB channel; the Bot API can't
 * be pointed at it per-bot safely), so this adapter speaks the Bot API
 * directly over `fetch` in LONG-POLLING mode:
 *
 *   setup    → getMe (identity), deleteWebhook (force polling mode),
 *              then a getUpdates loop (30s long-poll, offset tracking)
 *   deliver  → sendMessage
 *
 * Credential: TELEGRAM_BOT_TOKEN — the same key the /add-telegram CLI path
 * stores via the canonical .env writer, so pairing over the web API
 * (POST /web/channels/telegram/pair) and pairing over the CLI are one
 * system. Factory returns null while the token is absent; the registry's
 * startChannelAdapter starts this at runtime the moment pairing lands.
 *
 * Identity model (platform conventions used across the codebase):
 *   platform_id  `telegram:<chat_id>`   (namespacedPlatformId)
 *   sender       `telegram:<user_id>`   via content.senderId
 *   isMention    DMs always; groups when an @BotUsername entity or a reply
 *                to the bot is present ('platform' mention signal)
 *   threads      none (supportsThreads: false — Telegram chats are flat)
 *
 * TELEGRAM_API_BASE overrides the API host for tests — no live Telegram in
 * the suite, same seam pattern as ONCELLCLAW_GITHUB_API in cloud-start.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export const TELEGRAM_CHANNEL_TYPE = 'telegram';
export const TELEGRAM_TOKEN_ENV_KEY = 'TELEGRAM_BOT_TOKEN';

const DEFAULT_API_BASE = 'https://api.telegram.org';
/** Bot API long-poll hold time (server side), seconds. */
const LONG_POLL_SECONDS = 30;
/** HTTP budget: the long poll itself plus slack. */
const POLL_HTTP_TIMEOUT_MS = (LONG_POLL_SECONDS + 15) * 1000;
const CALL_HTTP_TIMEOUT_MS = 15_000;
/** Backoff after a failed poll — Telegram hiccups must not tight-loop. */
const POLL_ERROR_BACKOFF_MS = 5_000;

/** BotFather tokens: `<bot_id>:<35 url-safe chars>`. Shape-checked before
 *  any network call so garbage never reaches the API. */
export const TELEGRAM_TOKEN_PATTERN = /^\d{5,12}:[A-Za-z0-9_-]{30,50}$/;

/**
 * DMs engage on everything (a paired bot IS the conversation); groups are
 * mention-driven with platform-confirmed mentions. Unknown senders go
 * through approval — a Telegram bot is world-messageable by design.
 */
const TELEGRAM_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

export function telegramApiBase(): string {
  return process.env.TELEGRAM_API_BASE || DEFAULT_API_BASE;
}

/** Resolve the bot token (process.env first, then repo-root .env). */
export function readTelegramToken(): string {
  const file = readEnvFile([TELEGRAM_TOKEN_ENV_KEY]);
  return (process.env[TELEGRAM_TOKEN_ENV_KEY] ?? file[TELEGRAM_TOKEN_ENV_KEY] ?? '').trim();
}

export interface TelegramBotIdentity {
  id: number;
  username: string;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/** One Bot API call. Throws on transport failure; returns the envelope. */
async function callTelegram<T>(
  token: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs: number = CALL_HTTP_TIMEOUT_MS,
): Promise<TelegramApiEnvelope<T>> {
  const response = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as TelegramApiEnvelope<T>;
}

/**
 * Verify a token against getMe. Three-way outcome so the pairing endpoint
 * can map precisely to its 200/400/502 contract:
 *   { ok: true, bot }  — token valid
 *   { ok: false, reason: 'invalid_token' }      — Telegram rejected it
 *   { ok: false, reason: 'telegram_unreachable' } — transport failure
 */
export async function verifyTelegramToken(
  token: string,
): Promise<{ ok: true; bot: TelegramBotIdentity } | { ok: false; reason: 'invalid_token' | 'telegram_unreachable' }> {
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) return { ok: false, reason: 'invalid_token' };
  try {
    const envelope = await callTelegram<{ id: number; username?: string }>(token, 'getMe');
    if (!envelope.ok || !envelope.result) return { ok: false, reason: 'invalid_token' };
    return { ok: true, bot: { id: envelope.result.id, username: envelope.result.username ?? '' } };
  } catch (err) {
    log.warn('Telegram getMe unreachable', { err });
    return { ok: false, reason: 'telegram_unreachable' };
  }
}

/** Subset of the Bot API Update shape this adapter consumes. */
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    chat: { id: number; type: string; title?: string };
    from?: { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
    entities?: Array<{ type: string; offset: number; length: number }>;
    reply_to_message?: { from?: { id: number } };
  };
}

/** Platform-confirmed mention: @BotUsername entity, or a reply to the bot. */
export function isMentionOfBot(message: NonNullable<TelegramUpdate['message']>, bot: TelegramBotIdentity): boolean {
  if (message.chat.type === 'private') return true;
  if (message.reply_to_message?.from?.id === bot.id) return true;
  const text = message.text ?? message.caption ?? '';
  for (const entity of message.entities ?? []) {
    if (entity.type !== 'mention') continue;
    const mention = text.slice(entity.offset, entity.offset + entity.length);
    if (bot.username && mention.toLowerCase() === `@${bot.username.toLowerCase()}`) return true;
  }
  return false;
}

function senderName(from: NonNullable<TelegramUpdate['message']>['from']): string {
  if (!from) return 'unknown';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
}

function createAdapter(): ChannelAdapter | null {
  const token = readTelegramToken();
  if (!token) return null;

  let bot: TelegramBotIdentity | null = null;
  let polling = false;
  let pollAbort: AbortController | null = null;
  let offset = 0;

  async function pollLoop(config: ChannelSetup): Promise<void> {
    while (polling) {
      try {
        const envelope = await callTelegram<TelegramUpdate[]>(
          token,
          'getUpdates',
          { timeout: LONG_POLL_SECONDS, offset, allowed_updates: ['message'] },
          POLL_HTTP_TIMEOUT_MS,
        );
        if (!polling) return;
        if (!envelope.ok || !envelope.result) {
          log.warn('Telegram getUpdates rejected', { description: envelope.description });
          await backoff();
          continue;
        }
        for (const update of envelope.result) {
          offset = Math.max(offset, update.update_id + 1);
          handleUpdate(update, config);
        }
      } catch (err) {
        if (!polling) return;
        log.warn('Telegram poll failed — backing off', { err });
        await backoff();
      }
    }
  }

  function backoff(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, POLL_ERROR_BACKOFF_MS));
  }

  function handleUpdate(update: TelegramUpdate, config: ChannelSetup): void {
    const message = update.message;
    if (!message || !bot) return;
    if (message.from?.is_bot) return; // never route bot chatter (incl. ourselves)
    const text = message.text ?? message.caption ?? '';
    if (!text) return; // media-only updates carry nothing the router can use yet

    const isGroup = message.chat.type !== 'private';
    void config.onInbound(`${TELEGRAM_CHANNEL_TYPE}:${message.chat.id}`, null, {
      id: `tg-${update.update_id}`,
      kind: 'chat',
      timestamp: new Date(message.date * 1000).toISOString(),
      isMention: isMentionOfBot(message, bot),
      isGroup,
      content: {
        text,
        sender: senderName(message.from),
        senderId: message.from ? `${TELEGRAM_CHANNEL_TYPE}:${message.from.id}` : undefined,
      },
    });
    if (message.chat.title) {
      config.onMetadata(`${TELEGRAM_CHANNEL_TYPE}:${message.chat.id}`, message.chat.title, isGroup);
    }
  }

  const adapter: ChannelAdapter = {
    name: TELEGRAM_CHANNEL_TYPE,
    channelType: TELEGRAM_CHANNEL_TYPE,
    supportsThreads: false,
    defaults: TELEGRAM_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      const verified = await verifyTelegramToken(token);
      if (!verified.ok) {
        throw new Error(`Telegram setup failed: ${verified.reason}`);
      }
      bot = verified.bot;
      // Long-polling and webhooks are mutually exclusive on the Bot API —
      // clear any stale webhook so getUpdates actually receives traffic.
      // Best-effort: a transient failure here surfaces on the first poll.
      try {
        await callTelegram(token, 'deleteWebhook');
      } catch (err) {
        log.warn('Telegram deleteWebhook failed (continuing — poll will surface a real problem)', { err });
      }
      polling = true;
      pollAbort = new AbortController();
      void pollLoop(config);
      log.info('Telegram channel polling', { bot: `@${bot.username}` });
    },

    async teardown(): Promise<void> {
      polling = false;
      pollAbort?.abort();
      pollAbort = null;
    },

    isConnected(): boolean {
      return polling && bot !== null;
    },

    statusDetail(): string | undefined {
      return bot?.username ? `@${bot.username}` : undefined;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const chatId = platformId.startsWith(`${TELEGRAM_CHANNEL_TYPE}:`)
        ? platformId.slice(TELEGRAM_CHANNEL_TYPE.length + 1)
        : platformId;
      const text = extractText(message);
      if (text === null) return undefined;
      const envelope = await callTelegram<{ message_id: number }>(token, 'sendMessage', {
        chat_id: Number(chatId),
        text,
      });
      if (!envelope.ok || !envelope.result) {
        throw new Error(`Telegram sendMessage failed: ${envelope.description ?? 'unknown error'}`);
      }
      return String(envelope.result.message_id);
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

registerChannelAdapter(TELEGRAM_CHANNEL_TYPE, {
  factory: createAdapter,
  defaults: TELEGRAM_DEFAULTS,
  // The bot token IS the whole credential, and the pairing endpoint writes
  // it through upsertEnvVar into `.env` — a durable file. Nothing else of
  // this channel's touches disk, so a token pasted once outlives every
  // update. See src/durable-state.ts.
  durability: { credentialKeys: [TELEGRAM_TOKEN_ENV_KEY] },
});
