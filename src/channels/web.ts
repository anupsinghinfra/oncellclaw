/**
 * Web channel — talk to an agent group over plain HTTP, no messaging
 * platform involved.
 *
 * This is the channel a browser, a curl loop, or a hosting dashboard uses.
 * It mounts on the process's existing HTTP server (src/webhook-server.ts) —
 * there is exactly one listening port (WEBHOOK_PORT, else PORT, else 3000),
 * which is also what a supervisor-run service is handed.
 *
 * Endpoints (all JSON; `:group` is the messaging group's platform id):
 *
 *   POST /web/:group/message
 *        body  { "text": "...", "userId": "alice" }   userId optional
 *        → 202 { "ok": true, "id": "web-..." }
 *        Enqueues through the same ChannelSetup.onInbound seam every other
 *        adapter uses — router, engage rules, access gate, session
 *        resolution and container wake are all the normal path.
 *
 *   GET  /web/:group/messages?after=<cursor>&limit=<n>
 *        → 200 { "messages": [ { id, cursor, timestamp, kind, text, content } ],
 *                "cursor": "<cursor to pass as `after` next time>" }
 *        Poll-based. Reads the session outbound DBs the delivery path
 *        already writes — there is no second store, and no message is lost
 *        if a client is offline (unlike the CLI channel's live socket).
 *
 *   GET  /health
 *        → 200 { "ok": true, "groups": [ { slug, name, agents } ] }
 *        Liveness for the service supervisor and the hosting dashboard.
 *        Unauthenticated by design: it exposes no message content, and a
 *        health probe has no token to present.
 *
 * Auth: `Authorization: Bearer $ONCELLCLAW_WEB_TOKEN` on every /web/ route,
 * compared in constant time. When ONCELLCLAW_WEB_TOKEN is unset the channel
 * REFUSES TO START unless ONCELLCLAW_WEB_ALLOW_INSECURE=1 (local dev only).
 * A hosted instance's URL is public; this token is the whole boundary
 * between the internet and someone's assistant, so an unset token is a
 * misconfiguration, not a default.
 *
 * Rate limits (see ./rate-limit.ts; both return 429 {"error":"rate_limited"}
 * with a Retry-After header, and neither reveals anything about the token):
 *  - auth failures per client IP — sliding window, default 20/min
 *    (ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN). Consulted BEFORE the token
 *    compare, so an over-budget brute-forcer never reaches the comparison.
 *  - message POSTs per group — token bucket, default 30/min with the same
 *    burst (ONCELLCLAW_WEB_MESSAGES_PER_MIN); checked before the body is
 *    read, so malformed floods cost budget too. GET polls are unlimited:
 *    they are cheap reads of local SQLite and the dashboard polls steadily.
 *  - /health stays unlimited and unauthenticated.
 *
 * Delivery semantics: `deliver()` is an acknowledgement, not a send. The
 * outbound row is already durable in the session's outbound.db, which is
 * what the poll endpoint reads; acknowledging keeps the delivery poll from
 * retrying and eventually marking a perfectly good message failed. File
 * attachments are not carried — the outbox is cleared after delivery, and
 * this channel has no file transport.
 */
import crypto from 'crypto';
import type http from 'http';

import { readEnvFile } from '../env.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByChannel,
} from '../db/messaging-groups.js';
import { getDueOutboundMessages } from '../db/session-db.js';
import { getSessionsByMessagingGroup } from '../db/sessions.js';
import { log } from '../log.js';
import { openOutboundDb } from '../session-manager.js';
import { registerHttpRoute, unregisterHttpRoute } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { parseRatePerMin, SlidingWindowLimiter, TokenBucketLimiter } from './rate-limit.js';

/** Channel type + registry key. */
export const WEB_CHANNEL_TYPE = 'web';

/** Sender handle used when a client posts without one. Namespaced `web:owner`. */
export const WEB_DEFAULT_USER = 'owner';

/** Top-level HTTP segments this channel claims on the shared server. */
const WEB_ROUTE = 'web';
const HEALTH_ROUTE = 'health';

/** Refuse request bodies larger than this — a chat post, not an upload. */
const MAX_BODY_BYTES = 256 * 1024;

const DEFAULT_POLL_LIMIT = 100;
const MAX_POLL_LIMIT = 500;

/** Sender handles become `users.id` primary keys — keep them boring. */
const USER_ID_PATTERN = /^[A-Za-z0-9._@+-]{1,128}$/;

/** Auth failures one client IP may burn per minute before 429s. */
const DEFAULT_AUTH_FAILURES_PER_MIN = 20;
/** Accepted messages one group absorbs per minute (token bucket, same burst). */
const DEFAULT_MESSAGES_PER_MIN = 30;
const AUTH_WINDOW_MS = 60_000;

/**
 * HTTP transport with a bearer token in front of it: every request that got
 * past the token is trusted ('public'), every posted line is for the agent
 * (pattern '.'), and there is no thread concept. Same shape as the CLI
 * channel, where the 0600 socket plays the token's role.
 *
 * `mentions: 'dm-only'` is honest rather than 'never': each post is a direct
 * message to the assistant and is flagged as such, so mention-mode wirings
 * are usable on this channel.
 */
const WEB_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'dm-only',
};

export interface WebChannelEnv {
  token: string;
  allowInsecure: boolean;
  authFailuresPerMin: number;
  messagesPerMin: number;
}

/** Resolve the channel's env (process.env first, then repo-root .env). */
export function readWebChannelEnv(): WebChannelEnv {
  const file = readEnvFile([
    'ONCELLCLAW_WEB_TOKEN',
    'ONCELLCLAW_WEB_ALLOW_INSECURE',
    'ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN',
    'ONCELLCLAW_WEB_MESSAGES_PER_MIN',
  ]);
  return {
    token: (process.env.ONCELLCLAW_WEB_TOKEN ?? file.ONCELLCLAW_WEB_TOKEN ?? '').trim(),
    allowInsecure: (process.env.ONCELLCLAW_WEB_ALLOW_INSECURE ?? file.ONCELLCLAW_WEB_ALLOW_INSECURE ?? '') === '1',
    authFailuresPerMin: parseRatePerMin(
      process.env.ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN ?? file.ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN,
      DEFAULT_AUTH_FAILURES_PER_MIN,
    ),
    messagesPerMin: parseRatePerMin(
      process.env.ONCELLCLAW_WEB_MESSAGES_PER_MIN ?? file.ONCELLCLAW_WEB_MESSAGES_PER_MIN,
      DEFAULT_MESSAGES_PER_MIN,
    ),
  };
}

/**
 * Client IP for rate-limiting purposes.
 *
 * TRUST ASSUMPTION: on a hosted cell the only route to this port is the
 * platform's preview proxy, which sets X-Forwarded-For; the FIRST entry is
 * the real client, and later entries (appendable by anyone upstream) are
 * ignored. A caller who can reach the port directly (bare self-hosting) can
 * spoof XFF and rotate their apparent IP — that degrades the auth-failure
 * limiter back to "per presented IP", never below it, and the per-group
 * message limiter is keyed by group, not IP, so it is unaffected.
 */
export function clientIpOf(req: Pick<http.IncomingMessage, 'headers' | 'socket'>): string {
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const first = header?.split(',')[0]?.trim();
  return first || req.socket?.remoteAddress || 'unknown';
}

/**
 * Constant-time bearer comparison. Both sides are hashed first so the
 * timing-safe compare always sees equal-length inputs — otherwise
 * timingSafeEqual throws on a length mismatch, which leaks the length.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** Extract the bearer credential from an Authorization header, if present. */
function bearerOf(req: http.IncomingMessage): string {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : '';
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** Read a request body, refusing anything over MAX_BODY_BYTES. */
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'PayloadTooLargeError';
  }
}

/** One outbound message as the poll endpoint renders it. */
export interface WebOutboundItem {
  id: string;
  cursor: string;
  timestamp: string;
  kind: string;
  text: string | null;
  content: unknown;
}

/**
 * Poll cursor: `<timestamp>|<message id>`. Timestamp orders the stream;
 * the id breaks ties and makes the cursor a total order, which matters
 * because fan-out can put same-instant rows in different session DBs.
 * Opaque to clients — they only ever echo it back as `after`.
 */
function cursorOf(row: { timestamp: string; id: string }): string {
  return `${row.timestamp}|${row.id}`;
}

export function compareCursor(a: string, b: string): number {
  const split = (c: string): [string, string] => {
    const i = c.indexOf('|');
    return i === -1 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)];
  };
  const [at, ai] = split(a);
  const [bt, bi] = split(b);
  if (at !== bt) return at < bt ? -1 : 1;
  if (ai === bi) return 0;
  return ai < bi ? -1 : 1;
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

/**
 * Collect this messaging group's outbound messages after `after`.
 *
 * Reads messages_out from every session bound to the group (read-only open,
 * same as the delivery poll) and filters to rows addressed at this channel
 * + platform id. Internal traffic — system actions, task logs,
 * agent-to-agent — carries a different channel_type and is excluded by that
 * same filter, so nothing internal is ever exposed here.
 */
export function collectWebOutbound(
  messagingGroupId: string,
  platformId: string,
  after: string | null,
  limit: number,
): WebOutboundItem[] {
  const items: WebOutboundItem[] = [];

  for (const session of getSessionsByMessagingGroup(messagingGroupId)) {
    let db;
    try {
      db = openOutboundDb(session.agent_group_id, session.id);
    } catch {
      continue; // session folder not materialized yet — nothing to read
    }
    try {
      for (const row of getDueOutboundMessages(db)) {
        if (row.channel_type !== WEB_CHANNEL_TYPE || row.platform_id !== platformId) continue;
        const cursor = cursorOf(row as unknown as { timestamp: string; id: string });
        if (after !== null && compareCursor(cursor, after) <= 0) continue;
        let content: unknown;
        try {
          content = JSON.parse(row.content);
        } catch {
          content = { text: row.content };
        }
        items.push({
          id: row.id,
          cursor,
          timestamp: (row as unknown as { timestamp: string }).timestamp,
          kind: row.kind,
          text: textOf(content),
          content,
        });
      }
    } finally {
      db.close();
    }
  }

  items.sort((a, b) => compareCursor(a.cursor, b.cursor));
  return items.slice(0, limit);
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_POLL_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_POLL_LIMIT;
  return Math.min(n, MAX_POLL_LIMIT);
}

function generateId(): string {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createAdapter(): ChannelAdapter | null {
  const { token, allowInsecure, authFailuresPerMin, messagesPerMin } = readWebChannelEnv();
  if (!token && !allowInsecure) {
    log.error(
      'web channel NOT started — ONCELLCLAW_WEB_TOKEN is not set. The web channel exposes your assistant over HTTP; ' +
        'set a token, or set ONCELLCLAW_WEB_ALLOW_INSECURE=1 to run it unauthenticated on a trusted local network.',
    );
    return null;
  }
  if (!token) {
    log.warn('web channel started WITHOUT authentication (ONCELLCLAW_WEB_ALLOW_INSECURE=1) — local development only');
  }

  let mounted = false;

  // Per-IP budget of FAILED auth attempts (brute-force door) and per-group
  // budget of message POSTs (spam door — malformed floods cost budget too).
  // Process-local state, pruned inside the limiters.
  const authFailures = new SlidingWindowLimiter(authFailuresPerMin, AUTH_WINDOW_MS);
  const messageBudget = new TokenBucketLimiter(messagesPerMin);

  function sendRateLimited(res: http.ServerResponse, retryAfterSec: number): void {
    // Deliberately indistinguishable between the two limiters, and silent on
    // how close any presented token was.
    sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(retryAfterSec) });
  }

  /** Token gate. Returns true when the request may proceed. */
  function authorize(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!token) return true; // insecure mode, explicitly opted into above
    if (tokenMatches(bearerOf(req), token)) return true;
    sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="oncellclaw"' });
    return false;
  }

  async function handleWeb(req: http.IncomingMessage, res: http.ServerResponse, config: ChannelSetup): Promise<void> {
    // Brute-force gate BEFORE the token compare: an IP that has burned its
    // failure budget gets a 429 without the token ever being examined.
    const ip = clientIpOf(req);
    if (token) {
      const gate = authFailures.check(ip);
      if (!gate.allowed) {
        sendRateLimited(res, gate.retryAfterSec);
        return;
      }
    }

    // Token next: an unauthenticated caller learns nothing about which
    // groups exist, only that it needs a token. Each failure spends budget.
    if (!authorize(req, res)) {
      authFailures.record(ip);
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter((p) => p.length > 0);
    if (parts.length !== 3 || parts[0] !== WEB_ROUTE) {
      sendJson(res, 404, { error: 'not_found', hint: '/web/{group}/message | /web/{group}/messages' });
      return;
    }

    let slug: string;
    try {
      slug = decodeURIComponent(parts[1]!);
    } catch {
      sendJson(res, 400, { error: 'bad_group' });
      return;
    }
    const action = parts[2];

    // Unknown slugs are refused rather than auto-created: the router's
    // auto-create path exists for platforms that hand us real conversations,
    // and a public URL must not let anyone mint messaging_groups rows.
    const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, slug);
    if (!mg) {
      sendJson(res, 404, { error: 'unknown_group', group: slug });
      return;
    }

    if (req.method === 'POST' && action === 'message') {
      // Per-group spam gate, checked before the body is even read. Keyed by
      // group (not IP): the token holder is one principal, and the budget
      // protects the agent behind the group. GET polls stay unlimited.
      const gate = messageBudget.tryTake(slug);
      if (!gate.allowed) {
        sendRateLimited(res, gate.retryAfterSec);
        return;
      }
      await postMessage(req, res, config, slug);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && action === 'messages') {
      const after = url.searchParams.get('after');
      const limit = parseLimit(url.searchParams.get('limit'));
      const messages = collectWebOutbound(mg.id, slug, after, limit);
      sendJson(res, 200, {
        messages,
        cursor: messages.length > 0 ? messages[messages.length - 1]!.cursor : (after ?? ''),
      });
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
  }

  async function postMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: ChannelSetup,
    slug: string,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
        return;
      }
      throw err;
    }

    let payload: { text?: unknown; userId?: unknown };
    try {
      payload = JSON.parse(raw) as { text?: unknown; userId?: unknown };
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
    if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
      sendJson(res, 400, { error: 'text_required' });
      return;
    }

    const handle = typeof payload.userId === 'string' && payload.userId.length > 0 ? payload.userId : WEB_DEFAULT_USER;
    if (!USER_ID_PATTERN.test(handle)) {
      sendJson(res, 400, { error: 'invalid_user_id' });
      return;
    }

    const id = generateId();
    // Same seam every adapter uses: the host stamps channelType/instance and
    // hands this straight to routeInbound. Sender identity follows the
    // adapter contract's namespaced form (`<channelType>:<handle>`).
    await config.onInbound(slug, null, {
      id,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
      content: {
        text: payload.text,
        sender: handle,
        senderId: `${WEB_CHANNEL_TYPE}:${handle}`,
      },
    });

    sendJson(res, 202, { ok: true, id });
  }

  function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const groups = getMessagingGroupsByChannel(WEB_CHANNEL_TYPE).map((mg) => ({
        slug: mg.platform_id,
        name: mg.name,
        agents: getMessagingGroupAgents(mg.id).length,
      }));
      sendJson(res, 200, { ok: true, groups });
    } catch (err) {
      log.error('Health probe failed', { err });
      sendJson(res, 503, { ok: false });
    }
  }

  const adapter: ChannelAdapter = {
    name: WEB_CHANNEL_TYPE,
    channelType: WEB_CHANNEL_TYPE,
    supportsThreads: false,
    defaults: WEB_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      registerHttpRoute(WEB_ROUTE, (req, res) => handleWeb(req, res, config));
      registerHttpRoute(HEALTH_ROUTE, handleHealth);
      mounted = true;
      log.info('Web channel listening', { paths: ['/web/{group}/message', '/web/{group}/messages', '/health'] });
    },

    async teardown(): Promise<void> {
      unregisterHttpRoute(WEB_ROUTE);
      unregisterHttpRoute(HEALTH_ROUTE);
      mounted = false;
    },

    isConnected(): boolean {
      return mounted;
    },

    async deliver(): Promise<string | undefined> {
      // Acknowledge only — see the header note on delivery semantics.
      return undefined;
    },
  };

  return adapter;
}

registerChannelAdapter(WEB_CHANNEL_TYPE, { factory: createAdapter, defaults: WEB_DEFAULTS });
