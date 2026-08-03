/**
 * WhatsApp channel — trunk-shipped Baileys (WhatsApp Web) adapter.
 *
 * Mirrors src/channels/telegram.ts and discord.ts file-for-file, and exists
 * for the same reason they do: a hosted claw must be able to run this
 * channel without an LLM-driven skill editing its own checkout. cloud-start
 * re-extracts a pristine trunk tarball per commit sha, so a channel that is
 * INSTALLED rather than CONFIGURED pairs once and goes dark on the next
 * deploy. See src/durable-state.ts for the contract this obeys.
 *
 *   setup    → open a Baileys socket against the saved linked-device
 *              session, then `messages.upsert` routes inbound and
 *              `creds.update` rewrites the session as keys rotate
 *   deliver  → sock.sendMessage(jid, { text })
 *
 * Credential: not a token — a LINKED DEVICE SESSION under `store/auth`
 * (src/channels/whatsapp-session.ts), created by scanning a QR. The factory
 * returns null until `creds.json` exists; the QR relay
 * (src/channels/whatsapp-qr.ts, served at GET /web/channels/whatsapp/qr)
 * calls startChannelAdapter the moment a scan lands, so pairing lights the
 * channel up without a restart. `store/` is symlinked into `$BASE/state/`,
 * so the session outlives updates, restarts and pauses.
 *
 * Baileys is an OPTIONAL trunk dependency (package.json
 * `optionalDependencies`), loaded through a lazy dynamic import inside
 * setup() — ~46 MB of module graph that nothing but a paired WhatsApp
 * install should ever pay for, and an install that pruned optional deps
 * gets a legible error instead of a resolver stack trace.
 *
 * ── Shared vs dedicated number ────────────────────────────────────────────
 * ASSISTANT_HAS_OWN_NUMBER decides how this channel behaves, and the safe
 * reading of an absent value is SHARED (misreading a personal number as
 * dedicated makes the bot claim messages addressed to the human):
 *
 *   shared (default) — the linked line is the operator's own. Only their
 *     self-chat is the agent's; the adapter emits no mention signal ever
 *     (`mentions: 'never'`), groups engage on the agent's name, unknown
 *     senders are 'strict' (no stranger ever raises an approval card), and
 *     outbound is prefixed with the assistant's name.
 *   dedicated (=true) — the line is the bot's. Everything sent to it is for
 *     the bot: platform mentions, approval cards for unknown senders, no
 *     outbound prefix.
 *
 * ── Identity model (platform conventions used across the codebase) ────────
 *   platform_id  the JID as-is — `<phone>@s.whatsapp.net` / `<id>@g.us`.
 *                Native adapter: no `whatsapp:` prefix (src/platform-id.ts).
 *   sender       the normalized participant JID, device suffix stripped
 *                (see normalizeJid — a raw `…:12@…` would read as an
 *                already-namespaced user id).
 *   threads      none (supportsThreads: false — WhatsApp chats are flat)
 *
 * Test seam — no live WhatsApp and no Baileys anywhere in the suite:
 *   setWhatsappSocketFactory()  replaces the socket constructor wholesale.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  WHATSAPP_AUTH_SUBPATH,
  WHATSAPP_OPTIONAL_DEPS,
  isWhatsappPaired,
  normalizeJid,
  phoneFromJid,
  readLinkedPhone,
  whatsappAuthDir,
} from './whatsapp-session.js';

export const WHATSAPP_CHANNEL_TYPE = 'whatsapp';
export const WHATSAPP_OWN_NUMBER_ENV_KEY = 'ASSISTANT_HAS_OWN_NUMBER';
export const WHATSAPP_NAME_ENV_KEY = 'ASSISTANT_NAME';
export const DEFAULT_ASSISTANT_NAME = 'Andy';

/** JID suffix for 1:1 chats; anything ending `@g.us` is a group. */
const GROUP_JID_SUFFIX = '@g.us';
/** Backoff before reconnecting a dropped socket — never tight-loop. */
const RECONNECT_MS = 5_000;
/** Baileys close reason for a session the phone unlinked: do not reconnect. */
const LOGGED_OUT_STATUS = 401;
/** How many of our own outbound message ids to remember, so the echo of a
 *  reply we just sent is never routed back in as user input. */
const SENT_ID_MEMORY = 256;

// ── Configuration read from .env ───────────────────────────────────────────

/** True only for an explicit `ASSISTANT_HAS_OWN_NUMBER=true`. Everything
 *  else — absent, empty, 'false', garbage — is the safe shared reading. */
export function hasOwnNumber(): boolean {
  const file = readEnvFile([WHATSAPP_OWN_NUMBER_ENV_KEY]);
  return (process.env[WHATSAPP_OWN_NUMBER_ENV_KEY] ?? file[WHATSAPP_OWN_NUMBER_ENV_KEY] ?? '').trim() === 'true';
}

/** The assistant's display name — the outbound prefix and the group engage
 *  pattern on a shared number. */
export function assistantName(): string {
  const file = readEnvFile([WHATSAPP_NAME_ENV_KEY]);
  return (process.env[WHATSAPP_NAME_ENV_KEY] ?? file[WHATSAPP_NAME_ENV_KEY] ?? '').trim() || DEFAULT_ASSISTANT_NAME;
}

/**
 * Wiring defaults for the CURRENT number mode. Computed rather than const
 * because the mode is `.env`-driven — ChannelAdapter.defaults explicitly
 * allows an env-computed declaration (see adapter.ts), and the registry
 * prefers a live adapter's copy over the registration's load-time snapshot.
 *
 * `{name}` in the group pattern is substituted with the regex-escaped agent
 * group name by resolveWiringDefaults (src/channels/channel-defaults.ts).
 */
export function whatsappChannelDefaults(): ChannelDefaults {
  if (hasOwnNumber()) {
    return {
      dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
      group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
      mentions: 'platform',
    };
  }
  return {
    dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
    group: { engageMode: 'pattern', engagePattern: '\\b{name}\\b', threads: false, unknownSenderPolicy: 'strict' },
    mentions: 'never',
  };
}

// ── The Baileys surface this adapter uses ──────────────────────────────────

/** connection.update payload, narrowed to the fields we act on. */
export interface WhatsappConnectionUpdate {
  connection?: 'open' | 'close' | 'connecting';
  lastDisconnect?: { error?: { output?: { statusCode?: number } } } | null;
  qr?: string;
}

/** One inbound message, narrowed to the fields we route on. */
export interface WhatsappIncomingMessage {
  key: {
    remoteJid?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null;
  };
  message?: {
    conversation?: string | null;
    extendedTextMessage?: {
      text?: string | null;
      contextInfo?: { mentionedJid?: string[] | null; participant?: string | null } | null;
    } | null;
    imageMessage?: { caption?: string | null } | null;
    videoMessage?: { caption?: string | null } | null;
  } | null;
  pushName?: string | null;
  /** Seconds. Baileys hands this over as a number or a protobuf Long. */
  messageTimestamp?: number | string | { toNumber(): number } | null;
}

export interface WhatsappMessageUpsert {
  type: string;
  messages: WhatsappIncomingMessage[];
}

interface WhatsappEventMap {
  'connection.update': WhatsappConnectionUpdate;
  'messages.upsert': WhatsappMessageUpsert;
  'creds.update': void;
}

/** The socket surface the adapter drives. Baileys' real socket satisfies
 *  it structurally; tests inject a fake via setWhatsappSocketFactory. */
export interface WhatsappSocket {
  ev: {
    on<K extends keyof WhatsappEventMap>(event: K, listener: (payload: WhatsappEventMap[K]) => void): void;
  };
  user?: { id?: string | null } | null;
  sendMessage(jid: string, content: { text: string }): Promise<{ key?: { id?: string | null } | null } | undefined>;
  sendPresenceUpdate(type: string, jid?: string): Promise<void>;
  end(err?: Error): void;
}

/** What a factory hands back: the socket plus its credential writer. */
export interface WhatsappConnection {
  socket: WhatsappSocket;
  /** Wired to `creds.update` — this is what persists the session to disk. */
  saveCreds: () => Promise<void> | void;
}

export type WhatsappSocketFactory = (opts: { authDir: string }) => Promise<WhatsappConnection>;

let socketFactory: WhatsappSocketFactory | null = null;

/** Test seam: replace (or with null, restore) the Baileys socket constructor. */
export function setWhatsappSocketFactory(factory: WhatsappSocketFactory | null): void {
  socketFactory = factory;
}

/** Shape of the Baileys module, as much of it as the default factory uses. */
interface BaileysModule {
  makeWASocket: (config: Record<string, unknown>) => WhatsappSocket;
  default?: (config: Record<string, unknown>) => WhatsappSocket;
  useMultiFileAuthState: (dir: string) => Promise<{
    state: { creds: unknown; keys: unknown };
    saveCreds: () => Promise<void>;
  }>;
  makeCacheableSignalKeyStore: (keys: unknown, logger: unknown) => unknown;
  fetchLatestWaWebVersion: (opts: Record<string, unknown>) => Promise<{ version?: unknown }>;
  Browsers: { macOS: (name: string) => unknown };
}

/**
 * Load Baileys lazily.
 *
 * `import('… as string')` (the same idiom whatsapp-qr.ts uses for `qrcode`)
 * keeps tsc from binding to the package: it is an OPTIONAL dependency, and a
 * typecheck must not require it to be on disk. The cast to BaileysModule is
 * the type contract instead — narrow, and only over what we call.
 */
async function loadBaileys(): Promise<BaileysModule> {
  try {
    return (await import('@whiskeysockets/baileys' as string)) as BaileysModule;
  } catch (err) {
    throw new Error(
      `WhatsApp needs the optional trunk dependencies ${WHATSAPP_OPTIONAL_DEPS.join(', ')}, and they are not ` +
        `installed in this checkout. Re-run \`pnpm install\` without --no-optional.`,
      { cause: err },
    );
  }
}

/** A silent pino, or a no-op shim when pino was pruned with the rest. */
async function loadSilentLogger(): Promise<unknown> {
  try {
    const mod = (await import('pino' as string)) as { pino: (opts: { level: string }) => unknown };
    return mod.pino({ level: 'silent' });
  } catch (err) {
    // Baileys only ever calls logger methods; a shim keeps it running on an
    // install where pino is absent but Baileys somehow is not.
    log.warn('pino not installed — using a no-op logger for Baileys', { err });
    const noop = (): void => {};
    const shim: Record<string, unknown> = {
      level: 'silent',
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
    };
    shim.child = (): unknown => shim;
    return shim;
  }
}

async function defaultSocketFactory({ authDir }: { authDir: string }): Promise<WhatsappConnection> {
  const baileys = await loadBaileys();
  const logger = await loadSilentLogger();
  const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
  const { version } = await baileys.fetchLatestWaWebVersion({}).catch(() => ({ version: undefined }));
  const make = baileys.makeWASocket ?? baileys.default;
  const socket = make({
    version,
    auth: { creds: state.creds, keys: baileys.makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: baileys.Browsers.macOS('Chrome'),
  });
  return { socket, saveCreds };
}

// ── Message shaping ────────────────────────────────────────────────────────

/** Text carried by an inbound message, captions included ('' when none). */
export function extractInboundText(message: WhatsappIncomingMessage): string {
  const body = message.message;
  if (!body) return '';
  return (
    body.conversation ||
    body.extendedTextMessage?.text ||
    body.imageMessage?.caption ||
    body.videoMessage?.caption ||
    ''
  );
}

/** ISO timestamp from Baileys' number | string | protobuf-Long seconds. */
export function inboundTimestamp(raw: WhatsappIncomingMessage['messageTimestamp']): string {
  let seconds: number | null = null;
  if (typeof raw === 'number') seconds = raw;
  else if (typeof raw === 'string') seconds = Number.parseInt(raw, 10);
  else if (raw && typeof raw.toNumber === 'function') seconds = raw.toNumber();
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

/**
 * Platform-confirmed mention of the bot — only meaningful on a DEDICATED
 * number, where the line belongs to the bot. DMs are always addressed to it;
 * in groups WhatsApp gives us an explicit mentionedJid list, and a reply
 * carries the quoted author in contextInfo.participant.
 *
 * On a shared number the caller never asks: the human owns the line, so no
 * message is ever a bot mention (`mentions: 'never'`).
 */
export function isMentionOfBot(message: WhatsappIncomingMessage, ownJid: string): boolean {
  const remoteJid = message.key.remoteJid ?? '';
  if (!remoteJid.endsWith(GROUP_JID_SUFFIX)) return true;
  const context = message.message?.extendedTextMessage?.contextInfo;
  if (context?.mentionedJid?.some((jid) => normalizeJid(jid) === ownJid)) return true;
  if (context?.participant && normalizeJid(context.participant) === ownJid) return true;
  return false;
}

/** Who sent it: the group participant, else the chat itself for a DM. */
function senderJid(message: WhatsappIncomingMessage, ownJid: string): string {
  if (message.key.fromMe) return ownJid;
  const raw = message.key.participant || message.key.remoteJid || '';
  return raw ? normalizeJid(raw) : '';
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

// ── Adapter ────────────────────────────────────────────────────────────────

function createAdapter(): ChannelAdapter | null {
  // The linked-device session IS the credential. No session, no channel —
  // same contract as telegram/discord's absent token.
  if (!isWhatsappPaired()) return null;

  const defaults = whatsappChannelDefaults();
  const dedicated = hasOwnNumber();
  const name = assistantName();

  let connection: WhatsappConnection | null = null;
  let ownJid = '';
  let connected = false;
  let running = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ids of messages WE sent — their echoes must never route back in. */
  const sentIds = new Set<string>();

  function rememberSentId(id: string | null | undefined): void {
    if (!id) return;
    sentIds.add(id);
    if (sentIds.size > SENT_ID_MEMORY) {
      const oldest = sentIds.values().next().value;
      if (oldest !== undefined) sentIds.delete(oldest);
    }
  }

  /**
   * Should this message reach the router?
   *
   * The `fromMe` question is the whole shared-number design. On a shared
   * (personal) number the operator's SELF-CHAT is the agent's inbox, and
   * every message in it is `fromMe` — dropping them all would leave the
   * channel mute. So self-chat `fromMe` messages route, and only the echoes
   * of our own replies (ids we recorded at send time) are filtered. On a
   * dedicated number nothing `fromMe` is ever user input.
   */
  function shouldRoute(message: WhatsappIncomingMessage): boolean {
    const id = message.key.id ?? '';
    if (id && sentIds.has(id)) return false;
    if (!message.key.fromMe) return true;
    if (dedicated) return false;
    return normalizeJid(message.key.remoteJid ?? '') === ownJid;
  }

  function handleUpsert(upsert: WhatsappMessageUpsert, config: ChannelSetup): void {
    // 'append' is history backfill — replaying it would answer old messages.
    if (upsert.type !== 'notify') return;
    for (const message of upsert.messages ?? []) {
      const remoteJid = message.key.remoteJid;
      if (!remoteJid) continue;
      // Status broadcasts are not conversations.
      if (remoteJid === 'status@broadcast') continue;
      if (!shouldRoute(message)) continue;
      const text = extractInboundText(message);
      if (!text) continue; // media-only messages carry nothing the router can use yet

      const platformId = normalizeJid(remoteJid);
      const isGroup = platformId.endsWith(GROUP_JID_SUFFIX);
      void config.onInbound(platformId, null, {
        id: `wa-${message.key.id ?? Date.now()}`,
        kind: 'chat',
        timestamp: inboundTimestamp(message.messageTimestamp),
        // Shared number: the human owns the line, so nothing is ever a
        // mention of the bot — matches `mentions: 'never'`, and keeps a
        // stranger's DM from auto-creating a group or raising a card.
        isMention: dedicated ? isMentionOfBot(message, ownJid) : undefined,
        isGroup,
        content: {
          text,
          sender: message.pushName || phoneFromJid(senderJid(message, ownJid)) || 'unknown',
          senderId: senderJid(message, ownJid) || undefined,
        },
      });
    }
  }

  function handleConnectionUpdate(update: WhatsappConnectionUpdate, config: ChannelSetup): void {
    if (update.connection === 'open') {
      connected = true;
      ownJid = normalizeJid(connection?.socket.user?.id ?? '') || ownJid;
      log.info('WhatsApp channel connected', { phone: phoneFromJid(ownJid), mode: dedicated ? 'dedicated' : 'shared' });
      return;
    }
    if (update.connection !== 'close') return;
    connected = false;
    const status = update.lastDisconnect?.error?.output?.statusCode;
    if (status === LOGGED_OUT_STATUS) {
      // The phone unlinked this device. Reconnecting can only fail — the
      // session on disk is dead and the fix is a fresh QR scan.
      running = false;
      log.error(
        'WhatsApp session logged out from the phone — the saved credentials are dead. ' +
          `Re-pair (GET /web/channels/whatsapp/qr, or clear ${WHATSAPP_AUTH_SUBPATH} and run the pairing step).`,
      );
      return;
    }
    if (!running) return;
    log.warn('WhatsApp socket dropped — reconnecting', { status });
    scheduleReconnect(config);
  }

  function scheduleReconnect(config: ChannelSetup): void {
    if (!running || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(config).catch((err: unknown) => {
        log.warn('WhatsApp reconnect failed — backing off', { err });
        scheduleReconnect(config);
      });
    }, RECONNECT_MS);
    reconnectTimer.unref?.();
  }

  async function connect(config: ChannelSetup): Promise<void> {
    const factory = socketFactory ?? defaultSocketFactory;
    const fresh = await factory({ authDir: whatsappAuthDir() });
    connection = fresh;
    ownJid = normalizeJid(fresh.socket.user?.id ?? '') || ownJid;
    fresh.socket.ev.on('creds.update', () => {
      // THE line that makes a scan survive an update: the rotating session
      // is rewritten under store/, which cloud-start symlinks into state/.
      void Promise.resolve(fresh.saveCreds()).catch((err: unknown) =>
        log.error('WhatsApp credential save failed — the session may not survive a restart', { err }),
      );
    });
    fresh.socket.ev.on('messages.upsert', (upsert) => handleUpsert(upsert, config));
    fresh.socket.ev.on('connection.update', (update) => handleConnectionUpdate(update, config));
  }

  const adapter: ChannelAdapter = {
    name: WHATSAPP_CHANNEL_TYPE,
    channelType: WHATSAPP_CHANNEL_TYPE,
    supportsThreads: false,
    defaults,

    async setup(config: ChannelSetup): Promise<void> {
      running = true;
      // Seed the identity from the saved credentials so status and mention
      // matching are honest before the socket finishes opening.
      const phone = readLinkedPhone();
      if (phone) ownJid = `${phone}@s.whatsapp.net`;
      await connect(config);
      log.info('WhatsApp channel starting', { phone, mode: dedicated ? 'dedicated' : 'shared' });
    },

    async teardown(): Promise<void> {
      running = false;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const socket = connection?.socket;
      connection = null;
      try {
        socket?.end(undefined);
      } catch {
        // already gone
      }
    },

    isConnected(): boolean {
      return connected;
    },

    statusDetail(): string | undefined {
      const phone = phoneFromJid(ownJid) || readLinkedPhone();
      if (!phone) return undefined;
      return `+${phone} (${dedicated ? 'dedicated' : 'shared'} number)`;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const socket = connection?.socket;
      if (!socket) throw new Error('WhatsApp socket is not connected');
      // Native adapter: the JID is the platform id. Strip a `whatsapp:`
      // prefix defensively — rows written by a generic creation path may
      // carry one even though this adapter never emits it.
      const jid = platformId.startsWith(`${WHATSAPP_CHANNEL_TYPE}:`)
        ? platformId.slice(WHATSAPP_CHANNEL_TYPE.length + 1)
        : platformId;
      const text = extractText(message);
      if (text === null) return undefined;
      // Shared number: the reply arrives in a conversation the human also
      // writes in, so it has to say who is talking.
      const body = dedicated ? text : `${name}: ${text}`;
      const sent = await socket.sendMessage(jid, { text: body });
      const id = sent?.key?.id ?? undefined;
      rememberSentId(id);
      return id ?? undefined;
    },

    async setTyping(platformId): Promise<void> {
      const socket = connection?.socket;
      if (!socket) return;
      try {
        await socket.sendPresenceUpdate('composing', platformId);
      } catch (err) {
        log.debug('WhatsApp presence update failed', { err });
      }
    },
  };

  return adapter;
}

registerChannelAdapter(WHATSAPP_CHANNEL_TYPE, {
  factory: createAdapter,
  // Load-time snapshot for offline creation paths; a live adapter carries
  // its own freshly-computed copy, which the registry prefers.
  defaults: whatsappChannelDefaults(),
  durability: {
    // ASSISTANT_NAME / ASSISTANT_HAS_OWN_NUMBER are install-wide settings
    // this channel reads, not credentials it owns. The credential is the
    // linked-device session below.
    credentialKeys: [],
    statePaths: [WHATSAPP_AUTH_SUBPATH],
  },
});
