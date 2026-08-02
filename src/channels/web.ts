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
 *        Poll-based, OUTBOUND-ONLY (v1 — kept byte-stable for existing
 *        pollers). Reads the session outbound DBs the delivery path
 *        already writes — there is no second store, and no message is lost
 *        if a client is offline (unlike the CLI channel's live socket).
 *
 *   GET  /web/:group/transcript?after=<cursor>&limit=<n>
 *        → 200 { "messages": [ { id, cursor, timestamp, direction,
 *                userId?, kind, text } ], "cursor": "…" }
 *        The UNIFIED conversation: user rows from messages_in (the
 *        router's canonical durable record) merged with assistant rows
 *        from messages_out. Cursors are `timestamp|seq` with seq derived
 *        from insertion order — strictly monotonic even when host/cell
 *        clock skew makes a reply's timestamp regress, and replies are
 *        causally pinned after their `in_reply_to` question. Exact resume:
 *        after=<cursor of row N> returns rows N+1… .
 *
 *   POST /web/:group/archive
 *        → 200 { "ok": true, "epoch": "<cursor>" }
 *        Snapshots the transcript tail as the group's ARCHIVE EPOCH:
 *        /transcript and /stream render only rows after it, so the
 *        dashboard's "clear view" is a view boundary, not a deletion —
 *        every row stays durable in the session DBs (durable memory is
 *        the product). Idempotent; an empty view keeps the prior epoch.
 *        Never message-rate-limited: a cheap local write, no agent wake.
 *
 *   GET  /web/:group/stream?after=<cursor>          (Server-Sent Events)
 *        `event: message` frames whose data is one transcript row (same
 *        JSON as /transcript), pushed on arrival — no client polling.
 *        Replays history after `after` on connect; `: hb` comment
 *        heartbeats every ~25s double as catch-up sweeps. Same Bearer
 *        auth via headers (consume with fetch + ReadableStream). At most
 *        4 concurrent streams per group; the oldest is dropped beyond
 *        that.
 *
 *   GET  /health
 *        → 200 { "ok": true, "groups": [ { slug, name, agents } ] }
 *        Liveness for the service supervisor and the hosting dashboard.
 *        Unauthenticated by design: it exposes no message content, and a
 *        health probe has no token to present.
 *
 *   GET  /web/status                                       (token-authed)
 *        → 200 { version, groups, channels, skills }
 *        Introspection for the dashboard's Connections & Integrations
 *        panel: channels from the adapter registry with honestly-knowable
 *        configured/connected state, skills as name+description only (no
 *        file contents). Each group carries its run-cost ledger summed
 *        across sessions ({ costUsd, input/output/cache tokens, turns },
 *        null when nothing recorded). Never message-rate-limited (it is a
 *        read, like the poll endpoint), though auth failures still spend
 *        IP budget.
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
 *   GET  /web/:group/files/:fileId                          (token-authed)
 *        → 200 <raw bytes> with Content-Disposition: attachment
 *        Serves an outbound file attachment the agent sent (send_file).
 *        deliver() stages the buffers under DATA_DIR/web-files/<group>/
 *        at ack time — the session outbox is cleared right after delivery,
 *        so the staged copy is the durable one this endpoint reads.
 *        Transcript rows whose message carried files include
 *        `files: [{ id, filename, size, url }]` pointing here. Served as
 *        application/octet-stream + nosniff (never rendered inline — an
 *        HTML attachment must not become same-origin script).
 *
 * Delivery semantics: `deliver()` is an acknowledgement, not a send. The
 * outbound row is already durable in the session's outbound.db, which is
 * what the poll endpoint reads; acknowledging keeps the delivery poll from
 * retrying and eventually marking a perfectly good message failed. File
 * attachments ARE carried: deliver() stages them (see /files above), since
 * the outbox is cleared after delivery and this channel's transport is the
 * poll/stream read path.
 */
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import type http from 'http';
import path from 'path';

import { parse as parseYaml } from 'yaml';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByChannel,
  setMessagingGroupArchiveEpoch,
} from '../db/messaging-groups.js';
import {
  getDueOutboundMessages,
  getInboundTranscriptRows,
  readSessionCostTotals,
  type SessionCostTotals,
} from '../db/session-db.js';
import { getSessionsByMessagingGroup } from '../db/sessions.js';
import { log } from '../log.js';
import { openInboundDb, openOutboundDb } from '../session-manager.js';
import { envFilePath, removeEnvVar, upsertEnvVar } from '../env.js';
import { getCodeVersion } from '../upgrade-state.js';
import { registerHttpRoute, unregisterHttpRoute } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundFile } from './adapter.js';
import {
  getActiveAdapters,
  getRegisteredChannelNames,
  registerChannelAdapter,
  startChannelAdapter,
  stopChannelAdapter,
} from './channel-registry.js';
import { parseRatePerMin, SlidingWindowLimiter, TokenBucketLimiter } from './rate-limit.js';
import { DISCORD_CHANNEL_TYPE, DISCORD_TOKEN_ENV_KEY, verifyDiscordToken } from './discord.js';
import { TELEGRAM_CHANNEL_TYPE, TELEGRAM_TOKEN_ENV_KEY, verifyTelegramToken } from './telegram.js';
import {
  currentWhatsappQrState,
  ensureWhatsappPairing,
  onWhatsappQrChange,
  stopWhatsappPairing,
} from './whatsapp-qr.js';

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
const DEFAULT_TRANSCRIPT_LIMIT = 200;
const MAX_TRANSCRIPT_LIMIT = 1000;
/** Concurrent SSE streams per group — the oldest is dropped beyond this. */
const MAX_STREAMS_PER_GROUP = 4;
/** SSE heartbeat interval; overridable for tests (they must not wait 25s). */
function sseHeartbeatMs(): number {
  const raw = Number.parseInt(process.env.ONCELLCLAW_WEB_SSE_HEARTBEAT_MS ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 25_000;
}
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

/** Where pairing persists credentials — the install's canonical .env.
 *  ONCELLCLAW_ENV_FILE overrides it in tests so suites never touch a real
 *  .env; production never sets it. */
function webEnvFilePath(): string {
  return process.env.ONCELLCLAW_ENV_FILE || envFilePath();
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

/** One file attachment as a transcript row renders it. */
export interface WebTranscriptFile {
  id: string;
  filename: string;
  size: number;
  /** Same-origin download path: /web/{group}/files/{id} (token-authed). */
  url: string;
}

/** One transcript row — both directions share this shape. */
export interface WebTranscriptItem {
  id: string;
  cursor: string;
  /** The row's own recorded timestamp (may regress under clock skew; the
   *  cursor, not this field, carries the ordering). */
  timestamp: string;
  direction: 'user' | 'assistant';
  /** Posting user's handle (user rows only). */
  userId?: string;
  kind: string;
  text: string | null;
  /** Staged outbound attachments (assistant rows that carried files). */
  files?: WebTranscriptFile[];
  /** This reply's turn cost in USD (assistant rows whose runner stamped it) —
   *  the dashboard's subtle per-reply annotation. */
  costUsd?: number;
}

/** A merged row before cursor assignment (see the transcript registry). */
export interface WebTranscriptRow {
  id: string;
  timestamp: string;
  direction: 'user' | 'assistant';
  userId?: string;
  kind: string;
  text: string | null;
  files?: WebTranscriptFile[];
  costUsd?: number;
}

interface TranscriptSourceRow {
  id: string;
  seq: number;
  timestamp: string;
  kind: string;
  direction: 'user' | 'assistant';
  userId?: string;
  text: string | null;
  files?: WebTranscriptFile[];
  costUsd?: number;
  /** Assistant rows: the inbound message id this answers (causal anchor). */
  inReplyTo?: string | null;
}

// ── Outbound file staging ─────────────────────────────────────────────────
//
// The session outbox (the only place send_file buffers live) is cleared
// right after delivery, so deliver() copies the buffers into a
// channel-owned staging area, keyed by the messages_out row id:
//
//   DATA_DIR/web-files/<group>/<messageId>-<n>            file bytes
//   DATA_DIR/web-files/<group>/<messageId>.files.json     [{id,filename,size}]
//
// The web channel is the single writer here (same invariant as every other
// store in this system). Staged files are durable like the transcript rows
// that reference them — durable memory is the product; there is no TTL.

/** One staged attachment as recorded in the sidecar index. */
export interface WebFileRef {
  id: string;
  filename: string;
  size: number;
}

export function webFilesDir(slug: string): string {
  return path.join(DATA_DIR, 'web-files', slug);
}

/**
 * Stage a delivered message's file buffers and write the sidecar index.
 * Defensive on every input — an unsafe message id or filename skips staging
 * of that piece rather than failing the delivery ack (the message text is
 * already on screen; a staging problem must not re-deliver it).
 */
export function stageWebFiles(slug: string, messageId: string | undefined, files: OutboundFile[]): WebFileRef[] {
  if (!messageId || !isSafeAttachmentName(messageId) || !isSafeAttachmentName(slug)) {
    log.warn('Web file staging skipped — unsafe or missing message id/slug', { slug, messageId });
    return [];
  }
  try {
    const dir = webFilesDir(slug);
    fs.mkdirSync(dir, { recursive: true });
    const refs: WebFileRef[] = [];
    files.forEach((file, index) => {
      if (!isSafeAttachmentName(file.filename)) {
        log.warn('Web file staging skipped an unsafe filename', { slug, messageId, filename: file.filename });
        return;
      }
      const id = `${messageId}-${index}`;
      fs.writeFileSync(path.join(dir, id), file.data);
      refs.push({ id, filename: file.filename, size: file.data.length });
    });
    if (refs.length > 0) {
      fs.writeFileSync(path.join(dir, `${messageId}.files.json`), JSON.stringify(refs));
    }
    return refs;
  } catch (err) {
    log.warn('Web file staging failed', { slug, messageId, err });
    return [];
  }
}

/** Staged refs for one message — [] when nothing was staged (or malformed). */
export function readWebFileRefs(slug: string, messageId: string): WebFileRef[] {
  if (!isSafeAttachmentName(messageId) || !isSafeAttachmentName(slug)) return [];
  try {
    const raw = fs.readFileSync(path.join(webFilesDir(slug), `${messageId}.files.json`), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is WebFileRef =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as WebFileRef).id === 'string' &&
        typeof (entry as WebFileRef).filename === 'string' &&
        typeof (entry as WebFileRef).size === 'number',
    );
  } catch {
    return []; // no sidecar (pre-feature delivery, or files never staged)
  }
}

/** Transcript-facing refs for one outbound row: staged refs + download URL. */
function webTranscriptFiles(slug: string, messageId: string): WebTranscriptFile[] {
  return readWebFileRefs(slug, messageId).map((ref) => ({
    ...ref,
    url: `/${WEB_ROUTE}/${encodeURIComponent(slug)}/files/${encodeURIComponent(ref.id)}`,
  }));
}

/**
 * The unified conversation transcript for one web group: user rows from
 * messages_in (the router's canonical durable record of accepted inbound)
 * merged with assistant rows from messages_out — no second store.
 *
 * ORDERING. Each session DB file is an append-only stream in `seq` order
 * (its writer's true insertion order). The merge walks all streams and picks
 * the head with the smallest EFFECTIVE timestamp, where effective = max(row
 * timestamp, last emitted) — i.e. timestamps decide interleaving, but a row
 * whose clock regressed (host vs cell skew was producing replies "before"
 * their questions) is clamped forward instead of violating order.
 *
 * This is the deterministic BASELINE order. Cursor assignment lives in the
 * adapter's transcript registry, which discovers rows in this order but
 * pins each id to the index it was FIRST seen at — so a late-arriving row
 * whose timestamp lands mid-history still gets the next index (true
 * insertion order), and live streams never skip or re-deliver.
 */
export function buildWebTranscript(messagingGroupId: string, platformId: string): WebTranscriptRow[] {
  const streams: TranscriptSourceRow[][] = [];

  for (const session of getSessionsByMessagingGroup(messagingGroupId)) {
    const inboundRows: TranscriptSourceRow[] = [];
    try {
      const db = openInboundDb(session.agent_group_id, session.id);
      try {
        for (const row of getInboundTranscriptRows(db)) {
          if (row.channel_type !== WEB_CHANNEL_TYPE || row.platform_id !== platformId) continue;
          const content = safeParseContent(row.content);
          inboundRows.push({
            id: row.id,
            seq: row.seq ?? 0,
            timestamp: row.timestamp,
            kind: row.kind,
            direction: 'user',
            userId: senderHandleOf(content),
            text: typeof content.text === 'string' ? content.text : null,
          });
        }
      } finally {
        db.close();
      }
    } catch {
      // session folder not materialized yet — no user rows from it
    }
    if (inboundRows.length > 0) streams.push(inboundRows);

    const outboundRows: TranscriptSourceRow[] = [];
    try {
      const db = openOutboundDb(session.agent_group_id, session.id);
      try {
        for (const row of getDueOutboundMessages(db)) {
          if (row.channel_type !== WEB_CHANNEL_TYPE || row.platform_id !== platformId) continue;
          const content = safeParseContent(row.content);
          // Rows whose content declared files get their staged refs attached.
          // Degrades to no refs when nothing was staged (pre-feature
          // deliveries, or staging skipped) — the text still renders.
          const fileRefs = Array.isArray((content as { files?: unknown }).files)
            ? webTranscriptFiles(platformId, row.id)
            : [];
          const costUsd = (content as { costUsd?: unknown }).costUsd;
          outboundRows.push({
            id: row.id,
            seq: row.seq ?? 0,
            timestamp: row.timestamp ?? '',
            kind: row.kind,
            direction: 'assistant',
            text: typeof content.text === 'string' ? content.text : null,
            ...(fileRefs.length > 0 ? { files: fileRefs } : {}),
            ...(typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}),
            inReplyTo: row.in_reply_to,
          });
        }
      } finally {
        db.close();
      }
    } catch {
      // ditto
    }
    outboundRows.sort((a, b) => a.seq - b.seq);
    if (outboundRows.length > 0) streams.push(outboundRows);
  }

  // K-way merge with monotonic clamp (see doc above), plus a CAUSAL guard:
  // an assistant row that names its triggering inbound (in_reply_to) is
  // ineligible until that user row has been emitted — under host/cell clock
  // skew a reply can carry an EARLIER timestamp than its question, and
  // timestamps alone would order the answer first (the live bug). Progress
  // is guaranteed: user heads are always eligible, and the anchor is a user
  // row, so a blocked stream unblocks once its anchor's stream drains to it.
  const knownInboundIds = new Set(
    streams.flatMap((stream) => stream.filter((row) => row.direction === 'user').map((row) => row.id)),
  );
  const emittedInboundIds = new Set<string>();
  const pointers = streams.map(() => 0);
  const merged: WebTranscriptRow[] = [];
  let lastTs = '';
  for (;;) {
    let best = -1;
    let bestTs = '';
    for (let i = 0; i < streams.length; i++) {
      const head = streams[i]![pointers[i]!];
      if (!head) continue;
      if (
        head.direction === 'assistant' &&
        head.inReplyTo &&
        knownInboundIds.has(head.inReplyTo) &&
        !emittedInboundIds.has(head.inReplyTo)
      ) {
        continue; // causally blocked — its question hasn't been emitted yet
      }
      const effective = head.timestamp > lastTs ? head.timestamp : lastTs;
      if (best === -1 || effective < bestTs) {
        best = i;
        bestTs = effective;
      }
    }
    if (best === -1) break;
    const row = streams[best]![pointers[best]!]!;
    pointers[best]! += 1;
    lastTs = bestTs;
    if (row.direction === 'user') emittedInboundIds.add(row.id);
    merged.push({
      id: row.id,
      timestamp: row.timestamp,
      direction: row.direction,
      ...(row.userId !== undefined ? { userId: row.userId } : {}),
      kind: row.kind,
      text: row.text,
      ...(row.files !== undefined ? { files: row.files } : {}),
      ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
    });
  }
  return merged;
}

function parseTranscriptCursorIndex(cursor: string | null): number | null {
  if (!cursor) return null;
  const raw = cursor.slice(cursor.lastIndexOf('|') + 1);
  const index = Number.parseInt(raw, 10);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function senderHandleOf(content: { senderId?: unknown }): string | undefined {
  if (typeof content.senderId !== 'string') return undefined;
  const prefix = `${WEB_CHANNEL_TYPE}:`;
  return content.senderId.startsWith(prefix) ? content.senderId.slice(prefix.length) : content.senderId;
}

function safeParseContent(raw: string): { text?: unknown; senderId?: unknown } {
  try {
    return JSON.parse(raw) as { text?: unknown; senderId?: unknown };
  } catch {
    return { text: raw };
  }
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

/** One channel's honestly-knowable state, as /web/status reports it. */
export interface WebChannelStatus {
  type: string;
  configured: boolean;
  /** Live adapter's own isConnected(); null when there is no adapter to ask. */
  connected: boolean | null;
  detail?: string;
}

/**
 * The channel set a claw supports out of the box — what the dashboard's
 * Connections panel renders. Channels whose adapters are skill-installed
 * (not in trunk's registry) still appear here so there is a row to hang a
 * Connect button on; their detail says how to enable them.
 */
const SUPPORTED_CHANNELS: ReadonlyArray<{ type: string; unavailableDetail: string }> = [
  { type: 'web', unavailableDetail: 'not set up' },
  { type: 'cli', unavailableDetail: 'not set up' },
  { type: TELEGRAM_CHANNEL_TYPE, unavailableDetail: 'not set up — pair to enable' },
  { type: 'whatsapp', unavailableDetail: 'not set up — pair to enable' },
  { type: 'discord', unavailableDetail: 'not set up — pair to enable' },
  { type: 'imessage', unavailableDetail: 'requires a Mac — self-host only' },
];

/**
 * Enumerate the supported channel set (always all of SUPPORTED_CHANNELS,
 * even when unconfigured) merged with what the registry can honestly say:
 *
 *  - live adapter        → configured true, its own isConnected(), and its
 *                          statusDetail() (e.g. telegram's @BotUsername)
 *  - registered, factory null (credentials absent) → configured false,
 *                          connected null, the channel's enable hint
 *  - not even registered (skill-installed adapters absent from trunk) →
 *                          same shape; pairing/skill install flips it live
 *
 * Extra registrations beyond the manifest (skill-installed channels) are
 * appended after, so nothing installed ever disappears from status.
 */
export function collectChannelStatuses(): WebChannelStatus[] {
  const active = getActiveAdapters();
  const registered = new Set(getRegisteredChannelNames());
  const statusOf = (name: string, unavailableDetail: string): WebChannelStatus => {
    const adapter = active.find((a) => (a.instance ?? a.channelType) === name) ?? active.find((a) => a.name === name);
    if (adapter) {
      const detail = adapter.statusDetail?.();
      return {
        type: adapter.channelType,
        configured: true,
        connected: adapter.isConnected(),
        ...(detail ? { detail } : {}),
      };
    }
    return { type: name, configured: false, connected: null, detail: unavailableDetail };
  };

  const manifest = SUPPORTED_CHANNELS.map(({ type, unavailableDetail }) => statusOf(type, unavailableDetail));
  const manifestTypes = new Set(SUPPORTED_CHANNELS.map((c) => c.type));
  const extras = [...registered]
    .filter((name) => !manifestTypes.has(name))
    .map((name) => statusOf(name, 'adapter not started (credentials missing or channel disabled)'));
  return [...manifest, ...extras];
}

/**
 * Sum run-cost ledgers across every session bound to a messaging group —
 * what /web/status reports per group. The container's poll loop is the
 * single writer of the ledger (session_state `run_cost_totals`); this is a
 * read-only fold over it. Returns null when no session has recorded
 * anything (older sessions, providers without usage reporting) so the
 * dashboard can distinguish "zero dollars" from "no data".
 */
export function collectGroupCost(messagingGroupId: string): SessionCostTotals | null {
  let found = false;
  const sum: SessionCostTotals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 0,
  };
  for (const session of getSessionsByMessagingGroup(messagingGroupId)) {
    let db;
    try {
      db = openOutboundDb(session.agent_group_id, session.id);
    } catch {
      continue; // session folder not materialized yet
    }
    try {
      const totals = readSessionCostTotals(db);
      if (!totals) continue;
      found = true;
      sum.costUsd += totals.costUsd;
      sum.inputTokens += totals.inputTokens;
      sum.outputTokens += totals.outputTokens;
      sum.cacheReadTokens += totals.cacheReadTokens;
      sum.cacheCreationTokens += totals.cacheCreationTokens;
      sum.turns += totals.turns;
    } finally {
      db.close();
    }
  }
  return found ? sum : null;
}

/** name + description only — /web/status never exposes skill file contents. */
export interface WebSkillInfo {
  name: string;
  description: string;
}

/**
 * Catalog of shared skills from container/skills/<name>/SKILL.md YAML
 * frontmatter. Malformed or frontmatter-less skills degrade to their
 * directory name with an empty description rather than breaking status.
 */
export function collectSkillCatalog(): WebSkillInfo[] {
  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir).filter((entry) => fs.statSync(path.join(skillsDir, entry)).isDirectory());
  } catch {
    return []; // no shared skills directory in this install
  }

  return entries.map((dirName) => {
    let name = dirName;
    let description = '';
    try {
      const raw = fs.readFileSync(path.join(skillsDir, dirName, 'SKILL.md'), 'utf-8');
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1];
      if (frontmatter) {
        const meta = parseYaml(frontmatter) as { name?: unknown; description?: unknown } | null;
        if (typeof meta?.name === 'string' && meta.name.trim()) name = meta.name.trim();
        if (typeof meta?.description === 'string') description = meta.description.trim();
      }
    } catch {
      // unreadable/malformed SKILL.md — keep the directory-name fallback
    }
    return { name, description };
  });
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

  // Push transport: an in-process emitter fires per group slug whenever a
  // transcript row lands — at web inbound enqueue and at outbound delivery
  // ack — and every open SSE stream for that slug catches up. No polling
  // anywhere in the host.
  const transcriptEvents = new EventEmitter();
  transcriptEvents.setMaxListeners(0);
  const streamClients = new Map<string, Set<http.ServerResponse>>();

  // Transcript cursor registry: rows are DISCOVERED in the deterministic
  // merge order (buildWebTranscript) but each id keeps the index it was
  // first seen at — the spec's "derive seq from insertion order". Late
  // arrivals whose timestamps land mid-history therefore get the NEXT
  // index, cursors stay strictly monotonic, and a live stream can never
  // skip or re-deliver a row. The cursor's timestamp half is clamped to be
  // non-decreasing so the string itself is monotonic too. In-memory: a
  // restart rebuilds the same baseline deterministically from the files.
  interface TranscriptCursorEntry {
    index: number;
    cursorTs: string;
  }
  interface TranscriptRegistry {
    byId: Map<string, TranscriptCursorEntry>;
    nextIndex: number;
    lastCursorTs: string;
  }
  const transcriptRegistries = new Map<string, TranscriptRegistry>();

  function transcriptRows(messagingGroupId: string, slug: string): WebTranscriptItem[] {
    let registry = transcriptRegistries.get(slug);
    if (!registry) {
      registry = { byId: new Map(), nextIndex: 0, lastCursorTs: '' };
      transcriptRegistries.set(slug, registry);
    }
    const merged = buildWebTranscript(messagingGroupId, slug);
    for (const row of merged) {
      if (registry.byId.has(row.id)) continue;
      const cursorTs = row.timestamp > registry.lastCursorTs ? row.timestamp : registry.lastCursorTs;
      registry.byId.set(row.id, { index: registry.nextIndex++, cursorTs });
      registry.lastCursorTs = cursorTs;
    }
    const items = merged.map((row): WebTranscriptItem => {
      const entry = registry!.byId.get(row.id)!;
      return {
        id: row.id,
        cursor: `${entry.cursorTs}|${String(entry.index).padStart(9, '0')}`,
        timestamp: row.timestamp,
        direction: row.direction,
        ...(row.userId !== undefined ? { userId: row.userId } : {}),
        kind: row.kind,
        text: row.text,
        ...(row.files !== undefined ? { files: row.files } : {}),
        ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
      };
    });
    items.sort((a, b) => registry!.byId.get(a.id)!.index - registry!.byId.get(b.id)!.index);
    return items;
  }

  /**
   * Rows strictly after a transcript cursor (null/garbage = from the start),
   * floored by the group's archive epoch when one is set: an archived row is
   * still durable and still occupies its cursor index, it just never renders
   * here again. The floor composes with `after` by taking the max, so a
   * client resuming from a pre-epoch cursor lands exactly at the epoch.
   */
  function transcriptAfter(
    messagingGroupId: string,
    slug: string,
    after: string | null,
    limit: number,
    epoch: string | null = null,
  ): WebTranscriptItem[] {
    const all = transcriptRows(messagingGroupId, slug);
    const afterIndex = parseTranscriptCursorIndex(after);
    const epochIndex = parseTranscriptCursorIndex(epoch);
    const from = Math.max(afterIndex === null ? 0 : afterIndex + 1, epochIndex === null ? 0 : epochIndex + 1);
    return all.slice(from, from + limit);
  }

  function emitTranscriptEvent(slug: string): void {
    transcriptEvents.emit('row', slug);
    // The router's inbound write happens async behind onInbound (the host
    // fire-and-forgets routeInbound) — re-fire shortly after so a stream
    // never misses a row that was still being written on the first emit.
    setTimeout(() => transcriptEvents.emit('row', slug), 300).unref?.();
  }

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
    // /web/health mirrors /health: on hosted cells the preview proxy answers
    // top-level /health itself (host liveness) and never forwards it, so the
    // claw's own health must live under the /web/ prefix, which is forwarded.
    // Same contract: unauthenticated, unlimited, exposes no message content.
    const requestPath = (req.url ?? '/').split('?')[0];
    if (requestPath === `/${WEB_ROUTE}/${HEALTH_ROUTE}`) {
      handleHealth(req, res);
      return;
    }

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

    // Channel pairing for the dashboard's Connections panel. Authed (past
    // the token gate); NEVER message-rate-limited — the message budget
    // protects agent wakes, and pairing isn't one. 'channels' is a reserved
    // first segment: it can never be a group slug (provision normalizes
    // slugs but the router below would 404 an unknown group anyway).
    if (parts[0] === WEB_ROUTE && parts[1] === 'channels') {
      await handleChannels(req, res, parts.slice(2));
      return;
    }

    // Introspection for the dashboard. Authed (we are past the token gate),
    // never message-rate-limited — a read, like the poll endpoint.
    if (parts.length === 2 && parts[0] === WEB_ROUTE && parts[1] === 'status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
      }
      handleStatus(res);
      return;
    }

    const isFileRoute = parts.length === 4 && parts[2] === 'files';
    if (parts[0] !== WEB_ROUTE || (parts.length !== 3 && !isFileRoute)) {
      sendJson(res, 404, {
        error: 'not_found',
        hint: '/web/{group}/message | /web/{group}/messages | /web/{group}/files/{id} | /web/status',
      });
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

    if (isFileRoute) {
      // A read like the poll endpoints — token-authed above, never
      // message-rate-limited.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
      }
      let fileId: string;
      try {
        fileId = decodeURIComponent(parts[3]!);
      } catch {
        sendJson(res, 400, { error: 'bad_file_id' });
        return;
      }
      handleFile(req, res, slug, fileId);
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
    if ((req.method === 'GET' || req.method === 'HEAD') && action === 'transcript') {
      const after = url.searchParams.get('after');
      const limit = Math.min(
        Number.parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_TRANSCRIPT_LIMIT,
        MAX_TRANSCRIPT_LIMIT,
      );
      const epoch = mg.archive_epoch ?? null;
      const messages = transcriptAfter(mg.id, slug, after, limit, epoch);
      sendJson(res, 200, {
        messages,
        cursor: messages.length > 0 ? messages[messages.length - 1]!.cursor : (after ?? epoch ?? ''),
        epoch: epoch ?? '',
      });
      return;
    }
    if (req.method === 'POST' && action === 'archive') {
      // Deliberately NOT under the message budget: archiving is a cheap
      // local write that never wakes the agent — same reasoning as the
      // pairing endpoints. Auth was already enforced above.
      handleArchive(res, mg, slug);
      return;
    }
    if (req.method === 'GET' && action === 'stream') {
      handleStream(req, res, mg.id, slug, url.searchParams.get('after'), mg.archive_epoch ?? null);
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
    emitTranscriptEvent(slug);
  }

  /**
   * GET /web/{group}/stream — Server-Sent Events over the same Bearer auth
   * (the dashboard consumes it with fetch + ReadableStream, so the header
   * works; tokens never go in the query string). On connect it replays every
   * transcript row after `after`, then pushes rows as they land. A comment
   * heartbeat every ~25s keeps proxies from idling the connection out, and
   * doubles as a catch-up sweep so no row can slip between event edges.
   */
  function handleStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    messagingGroupId: string,
    slug: string,
    after: string | null,
    epoch: string | null = null,
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Disable proxy buffering (nginx et al.) — SSE must flush per event.
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    // Connection cap per group: register first, then evict the oldest past
    // the cap — a burst of reconnects converges on the newest connections.
    const clients = streamClients.get(slug) ?? new Set<http.ServerResponse>();
    streamClients.set(slug, clients);
    clients.add(res);
    while (clients.size > MAX_STREAMS_PER_GROUP) {
      const oldest = clients.values().next().value as http.ServerResponse;
      clients.delete(oldest);
      try {
        oldest.end();
      } catch {
        // already gone
      }
    }

    let lastCursor = after;
    let closed = false;
    const push = (): void => {
      if (closed) return;
      try {
        // The archive epoch is captured at connect time: rows landing after
        // the connection are post-epoch by construction, and a mid-stream
        // archive applies on the client's next connect.
        for (const item of transcriptAfter(messagingGroupId, slug, lastCursor, MAX_TRANSCRIPT_LIMIT, epoch)) {
          res.write(`event: message\ndata: ${JSON.stringify(item)}\n\n`);
          lastCursor = item.cursor;
        }
      } catch (err) {
        log.warn('SSE push failed', { slug, err });
      }
    };

    push(); // replay

    const onRow = (eventSlug: string): void => {
      if (eventSlug === slug) push();
    };
    transcriptEvents.on('row', onRow);
    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(': hb\n\n');
      push(); // catch-up sweep — belt for the emitter's braces
    }, sseHeartbeatMs());

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      transcriptEvents.off('row', onRow);
      clients.delete(res);
    };
    res.on('close', cleanup);
    req.on('close', cleanup);
  }

  /**
   * GET /web/{group}/files/{fileId} — serve one staged outbound attachment.
   *
   * The fileId is `<messageId>-<index>` (see stageWebFiles); the sidecar
   * index is the authority — a fileId that isn't listed there 404s even if
   * a same-named file existed. Everything is validated against traversal
   * (isSafeAttachmentName on both id and slug) before touching the
   * filesystem. Always application/octet-stream + attachment disposition +
   * nosniff: an agent-produced HTML/SVG file must download, never render
   * same-origin.
   */
  function handleFile(req: http.IncomingMessage, res: http.ServerResponse, slug: string, fileId: string): void {
    const parsed = /^(.+)-(\d+)$/.exec(fileId);
    if (!parsed || !isSafeAttachmentName(fileId) || !isSafeAttachmentName(slug)) {
      sendJson(res, 404, { error: 'unknown_file' });
      return;
    }
    const ref = readWebFileRefs(slug, parsed[1]!).find((entry) => entry.id === fileId);
    if (!ref) {
      sendJson(res, 404, { error: 'unknown_file' });
      return;
    }

    let data: Buffer;
    try {
      const blobPath = path.join(webFilesDir(slug), fileId);
      const stat = fs.lstatSync(blobPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        sendJson(res, 404, { error: 'unknown_file' });
        return;
      }
      data = fs.readFileSync(blobPath);
    } catch {
      sendJson(res, 404, { error: 'unknown_file' });
      return;
    }

    // ASCII-safe fallback filename for the disposition header; the exact
    // original name is available in the transcript row's file ref.
    const asciiName = ref.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${asciiName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /**
   * POST /web/{group}/archive — snapshot the transcript tail as the group's
   * archive epoch (persisted on messaging_groups; survives restarts). No
   * data is deleted: the epoch only moves where /transcript and /stream
   * start rendering. Idempotent — re-archiving an already-empty view keeps
   * the prior epoch, and the epoch never moves backwards.
   */
  function handleArchive(
    res: http.ServerResponse,
    mg: { id: string; archive_epoch?: string | null },
    slug: string,
  ): void {
    try {
      const rows = transcriptRows(mg.id, slug);
      const tail = rows.length > 0 ? rows[rows.length - 1]!.cursor : null;
      const previous = mg.archive_epoch ?? null;
      const tailIndex = parseTranscriptCursorIndex(tail);
      const previousIndex = parseTranscriptCursorIndex(previous);
      const advances = tailIndex !== null && (previousIndex === null || tailIndex > previousIndex);
      const epoch = advances ? tail : previous;
      if (advances && epoch) setMessagingGroupArchiveEpoch(mg.id, epoch);
      log.info('Web transcript archived', { slug, epoch: epoch ?? '' });
      sendJson(res, 200, { ok: true, epoch: epoch ?? '' });
    } catch (err) {
      log.error('Archive endpoint failed', { slug, err });
      sendJson(res, 500, { error: 'archive_failed' });
    }
  }

  /** Close every open SSE stream (channel teardown). */
  function closeAllStreams(): void {
    for (const clients of streamClients.values()) {
      for (const client of clients) {
        try {
          client.end();
        } catch {
          // already gone
        }
      }
      clients.clear();
    }
    streamClients.clear();
    transcriptEvents.removeAllListeners();
  }

  /**
   * /web/channels/... dispatcher. Contract (mirrored by the dashboard UI):
   *
   *   POST   /web/channels/telegram/pair   {"botToken": "..."}
   *          → 200 {"ok":true,"bot":{"username":"..."}}
   *          → 400 {"error":"invalid_token"}        bad shape or getMe rejected
   *          → 502 {"error":"telegram_unreachable"} transport failure to Telegram
   *   DELETE /web/channels/telegram
   *          → 200 {"ok":true}                      adapter stopped, credential removed
   *
   *   POST   /web/channels/discord/pair    {"botToken": "..."}
   *          → 200 {"ok":true,"bot":{"username":"..."}}
   *          → 400 {"error":"invalid_token"}        bad shape or /users/@me rejected
   *          → 502 {"error":"discord_unreachable"}  transport failure to Discord
   *   DELETE /web/channels/discord
   *          → 200 {"ok":true}                      adapter stopped, credential removed
   *
   *   GET    /web/channels/whatsapp/qr             (?stream=1 for SSE)
   *          → 200 { status, qr, pngBase64, error?, version }
   *          QR pairing relay: starts (or attaches to) a pairing session
   *          driven by the canonical setup/whatsapp-auth step and serves
   *          the current rotating QR until the phone scans it. `status`
   *          walks starting → qr_ready → paired | already_paired | failed.
   *          With ?stream=1 the same JSON rides SSE `event: qr` frames,
   *          pushed on every rotation, ending after a terminal state.
   *          See src/channels/whatsapp-qr.ts for the trunk boundaries
   *          (Baileys/qrcode are add-whatsapp-installed).
   */
  async function handleChannels(req: http.IncomingMessage, res: http.ServerResponse, rest: string[]): Promise<void> {
    if (rest[0] === TELEGRAM_CHANNEL_TYPE) {
      if (req.method === 'POST' && rest[1] === 'pair' && rest.length === 2) {
        await pairTelegram(req, res);
        return;
      }
      if (req.method === 'DELETE' && rest.length === 1) {
        await unpairTelegram(res);
        return;
      }
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, DELETE' });
      return;
    }
    if (rest[0] === DISCORD_CHANNEL_TYPE) {
      if (req.method === 'POST' && rest[1] === 'pair' && rest.length === 2) {
        await pairDiscord(req, res);
        return;
      }
      if (req.method === 'DELETE' && rest.length === 1) {
        await unpairDiscord(res);
        return;
      }
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, DELETE' });
      return;
    }
    if (rest[0] === 'whatsapp') {
      // QR relay only — WhatsApp has no token to POST; pairing IS the scan.
      if ((req.method === 'GET' || req.method === 'HEAD') && rest[1] === 'qr' && rest.length === 2) {
        handleWhatsappQr(req, res);
        return;
      }
      sendJson(res, 404, { error: 'not_found', hint: '/web/channels/whatsapp/qr' });
      return;
    }
    sendJson(res, 404, {
      error: 'unknown_channel',
      hint: '/web/channels/telegram | /web/channels/discord | /web/channels/whatsapp/qr',
    });
  }

  /**
   * GET /web/channels/whatsapp/qr — the pairing relay. A read like the
   * other GETs (token-authed upstream, never message-rate-limited). The
   * first request starts the pairing session; every request returns the
   * current state. `?stream=1` upgrades to SSE and pushes a frame per
   * rotation until a terminal state closes the stream.
   */
  function handleWhatsappQr(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const state = ensureWhatsappPairing();

    if (url.searchParams.get('stream') !== '1') {
      sendJson(res, 200, state);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    let closed = false;
    let lastVersion = -1;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    const push = (): void => {
      if (closed) return;
      const current = currentWhatsappQrState() ?? state;
      if (current.version === lastVersion) return;
      lastVersion = current.version;
      res.write(`event: qr\ndata: ${JSON.stringify(current)}\n\n`);
      if (current.status === 'paired' || current.status === 'already_paired' || current.status === 'failed') {
        cleanup();
        res.end();
      }
    };
    const unsubscribe = onWhatsappQrChange(push);
    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(': hb\n\n');
      push(); // catch-up sweep, same belt-and-braces as the transcript stream
    }, sseHeartbeatMs());
    res.on('close', cleanup);
    req.on('close', cleanup);

    push(); // initial frame (may already be terminal)
  }

  async function pairTelegram(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

    let payload: { botToken?: unknown };
    try {
      payload = JSON.parse(raw) as { botToken?: unknown };
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
    const botToken = typeof payload.botToken === 'string' ? payload.botToken.trim() : '';
    if (!botToken) {
      sendJson(res, 400, { error: 'invalid_token' });
      return;
    }

    // Shape check + live getMe. Shape failures never reach the network.
    const verified = await verifyTelegramToken(botToken);
    if (!verified.ok) {
      sendJson(res, verified.reason === 'invalid_token' ? 400 : 502, { error: verified.reason });
      return;
    }

    // Persist where the CLI path persists (the ONE canonical store), and
    // export to process.env so the adapter factory sees it immediately.
    upsertEnvVar(TELEGRAM_TOKEN_ENV_KEY, botToken, webEnvFilePath());
    process.env[TELEGRAM_TOKEN_ENV_KEY] = botToken;

    try {
      const adapter = await startChannelAdapter(TELEGRAM_CHANNEL_TYPE);
      if (!adapter) {
        // Factory declined despite the credential — should not happen; be loud.
        sendJson(res, 502, { error: 'telegram_unreachable' });
        return;
      }
    } catch (err) {
      log.error('Telegram adapter failed to start after pairing', { err });
      sendJson(res, 502, { error: 'telegram_unreachable' });
      return;
    }

    log.info('Telegram paired', { bot: `@${verified.bot.username}` });
    sendJson(res, 200, { ok: true, bot: { username: verified.bot.username } });
  }

  async function unpairTelegram(res: http.ServerResponse): Promise<void> {
    await stopChannelAdapter(TELEGRAM_CHANNEL_TYPE);
    removeEnvVar(TELEGRAM_TOKEN_ENV_KEY, webEnvFilePath());
    delete process.env[TELEGRAM_TOKEN_ENV_KEY];
    log.info('Telegram unpaired — adapter stopped, credential removed');
    sendJson(res, 200, { ok: true });
  }

  /** Mirrors pairTelegram — same body shape, same 200/400/502 contract. */
  async function pairDiscord(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

    let payload: { botToken?: unknown };
    try {
      payload = JSON.parse(raw) as { botToken?: unknown };
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
    const botToken = typeof payload.botToken === 'string' ? payload.botToken.trim() : '';
    if (!botToken) {
      sendJson(res, 400, { error: 'invalid_token' });
      return;
    }

    // Shape check + live GET /users/@me (the getMe equivalent). Shape
    // failures never reach the network.
    const verified = await verifyDiscordToken(botToken);
    if (!verified.ok) {
      sendJson(res, verified.reason === 'invalid_token' ? 400 : 502, { error: verified.reason });
      return;
    }

    // Persist where the CLI path persists (the ONE canonical store), and
    // export to process.env so the adapter factory sees it immediately.
    upsertEnvVar(DISCORD_TOKEN_ENV_KEY, botToken, webEnvFilePath());
    process.env[DISCORD_TOKEN_ENV_KEY] = botToken;

    try {
      const adapter = await startChannelAdapter(DISCORD_CHANNEL_TYPE);
      if (!adapter) {
        // Factory declined despite the credential — should not happen; be loud.
        sendJson(res, 502, { error: 'discord_unreachable' });
        return;
      }
    } catch (err) {
      log.error('Discord adapter failed to start after pairing', { err });
      sendJson(res, 502, { error: 'discord_unreachable' });
      return;
    }

    log.info('Discord paired', { bot: `@${verified.bot.username}` });
    sendJson(res, 200, { ok: true, bot: { username: verified.bot.username } });
  }

  async function unpairDiscord(res: http.ServerResponse): Promise<void> {
    await stopChannelAdapter(DISCORD_CHANNEL_TYPE);
    removeEnvVar(DISCORD_TOKEN_ENV_KEY, webEnvFilePath());
    delete process.env[DISCORD_TOKEN_ENV_KEY];
    log.info('Discord unpaired — adapter stopped, credential removed');
    sendJson(res, 200, { ok: true });
  }

  function handleStatus(res: http.ServerResponse): void {
    try {
      let version = 'unknown';
      try {
        version = getCodeVersion();
      } catch {
        // package.json unreadable — report 'unknown' rather than failing status
      }
      const groups = getMessagingGroupsByChannel(WEB_CHANNEL_TYPE).map((mg) => ({
        slug: mg.platform_id,
        name: mg.name,
        agents: getMessagingGroupAgents(mg.id).length,
        // Run-cost ledger summed across the group's sessions; null = no
        // data recorded yet (distinct from a genuine $0).
        cost: collectGroupCost(mg.id),
      }));
      sendJson(res, 200, {
        version,
        groups,
        channels: collectChannelStatuses(),
        skills: collectSkillCatalog(),
      });
    } catch (err) {
      log.error('Status endpoint failed', { err });
      sendJson(res, 500, { error: 'status_failed' });
    }
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
      closeAllStreams();
      stopWhatsappPairing();
      mounted = false;
    },

    isConnected(): boolean {
      return mounted;
    },

    async deliver(platformId, _threadId, message): Promise<string | undefined> {
      // Stage file attachments BEFORE acknowledging: the delivery poll
      // clears the session outbox right after this returns, so these
      // buffers are the last chance to keep the bytes. Staging is
      // best-effort — a failure logs and the ack still happens (the text
      // is durable in outbound.db; re-delivering it would duplicate it on
      // the user's screen).
      if (message.files && message.files.length > 0) {
        stageWebFiles(platformId, message.id, message.files);
      }
      // Acknowledge — see the header note on delivery semantics. The
      // ack IS the outbound push point: the row is durably in outbound.db
      // (that's what the delivery poll just read), so streams can see it.
      emitTranscriptEvent(platformId);
      return undefined;
    },
  };

  return adapter;
}

registerChannelAdapter(WEB_CHANNEL_TYPE, { factory: createAdapter, defaults: WEB_DEFAULTS });
