/**
 * Session lifecycle management.
 * Creates session folders + DBs, writes messages, manages container status.
 *
 * Two-DB architecture: each session has inbound.db (host-owned) and outbound.db
 * (container-owned). This eliminates SQLite write contention across the
 * host-container mount boundary — each file has exactly one writer.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDestinations } from './db/agent-destinations.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { createSession, findSession, findSessionByAgentGroup, getSession, updateSession } from './db/sessions.js';
import { log } from './log.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './db/schema.js';
import type { Session } from './types.js';

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

/** Path to the host-owned inbound DB (messages_in + delivered). */
export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'inbound.db');
}

/** Path to the container-owned outbound DB (messages_out + processing_ack). */
export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
}

/** Path to the container heartbeat file (touched instead of DB writes). */
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}

/**
 * @deprecated Use inboundDbPath / outboundDbPath instead.
 * Kept temporarily for test compatibility during migration.
 */
export function sessionDbPath(agentGroupId: string, sessionId: string): string {
  return inboundDbPath(agentGroupId, sessionId);
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Find or create a session for a messaging group + thread.
 *
 * Session modes:
 * - 'shared': one session per messaging group (ignores threadId)
 * - 'per-thread': one session per (messaging group, thread)
 * - 'agent-shared': one session per agent group — all messaging groups
 *   wired with this mode share a single session (e.g. GitHub + Slack)
 */
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): { session: Session; created: boolean } {
  // agent-shared: single session per agent group, regardless of messaging group
  if (sessionMode === 'agent-shared') {
    const existing = findSessionByAgentGroup(agentGroupId);
    if (existing) {
      return { session: existing, created: false };
    }
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    const existing = findSession(messagingGroupId, lookupThreadId);
    if (existing) {
      return { session: existing, created: false };
    }
  }

  const id = generateId();
  const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: lookupThreadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId, sessionMode });

  return { session, created: true };
}

/** Create the session folder and initialize both DBs. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });

  const inPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(inPath)) {
    const db = new Database(inPath);
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    db.close();
    log.debug('Inbound DB created', { dbPath: inPath });
  }

  const outPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(outPath)) {
    const db = new Database(outPath);
    db.pragma('journal_mode = DELETE');
    db.exec(OUTBOUND_SCHEMA);
    db.close();
    log.debug('Outbound DB created', { dbPath: outPath });
  }
}

/**
 * Write the session's destination map into its inbound.db `destinations` table.
 *
 * Called before every container wake so admin changes take effect on next start —
 * but the container also re-queries on demand, so mid-session admin changes
 * (e.g. spawning a new child agent) can also call this to push the new map
 * without restarting the container.
 *
 * Uses DELETE + INSERT in a transaction for a clean overwrite.
 */
export function writeDestinations(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const rows = getDestinations(agentGroupId);
  type DestRow = {
    name: string;
    display_name: string | null;
    type: 'channel' | 'agent';
    channel_type: string | null;
    platform_id: string | null;
    agent_group_id: string | null;
  };
  const resolved: DestRow[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        display_name: mg.name ?? row.local_name,
        type: 'channel',
        channel_type: mg.channel_type,
        platform_id: mg.platform_id,
        agent_group_id: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        display_name: ag.name,
        type: 'agent',
        channel_type: null,
        platform_id: null,
        agent_group_id: ag.id,
      });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  try {
    const tx = db.transaction((entries: DestRow[]) => {
      db.prepare('DELETE FROM destinations').run();
      const stmt = db.prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (@name, @display_name, @type, @channel_type, @platform_id, @agent_group_id)`,
      );
      for (const e of entries) stmt.run(e);
    });
    tx(resolved);
  } finally {
    db.close();
  }
  log.debug('Destination map written', { sessionId, count: resolved.length });
}

/** Write a message to a session's inbound DB (messages_in). Host-only. */
export function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    content: string;
    processAfter?: string | null;
    recurrence?: string | null;
  },
): void {
  // Extract base64 attachment data, save to inbox, replace with file paths
  const content = extractAttachmentFiles(agentGroupId, sessionId, message.id, message.content);

  const dbPath = inboundDbPath(agentGroupId, sessionId);
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');

  try {
    // Host uses even seq numbers, container uses odd — prevents collisions
    // across the two-DB boundary without cross-DB coordination.
    const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
    const nextSeq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2); // next even

    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence)
       VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content, @processAfter, @recurrence)`,
    ).run({
      id: message.id,
      seq: nextSeq,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      content,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
    });
  } finally {
    db.close();
  }

  updateSession(sessionId, { last_active: new Date().toISOString() });
}

/**
 * If message content has attachments with base64 `data`, save them to
 * the session's inbox directory and replace with `localPath`.
 */
function extractAttachmentFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  contentStr: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return contentStr;

  let changed = false;
  for (const att of attachments) {
    if (typeof att.data === 'string') {
      const inboxDir = path.join(sessionDir(agentGroupId, sessionId), 'inbox', messageId);
      fs.mkdirSync(inboxDir, { recursive: true });
      const filename = (att.name as string) || `attachment-${Date.now()}`;
      const filePath = path.join(inboxDir, filename);
      fs.writeFileSync(filePath, Buffer.from(att.data as string, 'base64'));
      att.localPath = `inbox/${messageId}/${filename}`;
      delete att.data;
      changed = true;
      log.debug('Saved attachment to inbox', { messageId, filename, size: att.size });
    }
  }

  return changed ? JSON.stringify(parsed) : contentStr;
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * @deprecated Use openInboundDb / openOutboundDb instead.
 */
export function openSessionDb(agentGroupId: string, sessionId: string): Database.Database {
  return openInboundDb(agentGroupId, sessionId);
}

/** Write a system response to a session's inbound.db so the container's findQuestionResponse() picks it up. */
export function writeSystemResponse(
  agentGroupId: string,
  sessionId: string,
  requestId: string,
  status: string,
  result: Record<string, unknown>,
): void {
  writeSessionMessage(agentGroupId, sessionId, {
    id: `sys-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      type: 'question_response',
      questionId: requestId,
      status,
      result,
    }),
  });
}

/** Mark a container as running for a session. */
export function markContainerRunning(sessionId: string): void {
  updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
}

/** Mark a container as idle for a session. */
export function markContainerIdle(sessionId: string): void {
  updateSession(sessionId, { container_status: 'idle' });
}

/** Mark a container as stopped for a session. */
export function markContainerStopped(sessionId: string): void {
  updateSession(sessionId, { container_status: 'stopped' });
}
