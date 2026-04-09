/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack from outbound.db to sync message status
 *   - Writes to inbound.db (host-owned) for status updates and recurrence
 *   - Uses heartbeat file mtime for stale container detection (not DB writes)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, inboundDbPath, outboundDbPath, heartbeatPath } from './session-manager.js';
import { wakeContainer, isContainerRunning } from './container-runner.js';
import type { Session } from './types.js';

const SWEEP_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Check for due pending messages → wake container
    const dueMessages = inDb
      .prepare(
        `SELECT COUNT(*) as count FROM messages_in
         WHERE status = 'pending'
           AND (process_after IS NULL OR process_after <= datetime('now'))`,
      )
      .get() as { count: number };

    if (dueMessages.count > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueMessages.count });
      await wakeContainer(session);
    }

    // 3. Detect stale containers via heartbeat file
    if (outDb) {
      detectStaleContainers(inDb, outDb, session, agentGroup.id);
    }

    // 4. Handle recurrence for completed messages
    handleRecurrence(inDb, session);
  } finally {
    inDb.close();
    outDb?.close();
  }
}

/**
 * Sync completed/failed processing_ack entries → messages_in.status.
 * Only syncs terminal states — 'processing' is handled by stale detection.
 */
function syncProcessingAcks(inDb: Database.Database, outDb: Database.Database): void {
  const completed = outDb
    .prepare("SELECT message_id FROM processing_ack WHERE status IN ('completed', 'failed')")
    .all() as Array<{ message_id: string }>;

  if (completed.length === 0) return;

  // Batch-update messages_in status for completed/failed messages
  const updateStmt = inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status != 'completed'");
  inDb.transaction(() => {
    for (const { message_id } of completed) {
      updateStmt.run(message_id);
    }
  })();
}

/**
 * Detect stale containers using heartbeat file mtime.
 * If the heartbeat is older than STALE_THRESHOLD and processing_ack has
 * 'processing' entries, the container likely crashed — reset with backoff.
 */
function detectStaleContainers(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const hbPath = heartbeatPath(agentGroupId, session.id);
  let heartbeatAge = Infinity;
  try {
    const stat = fs.statSync(hbPath);
    heartbeatAge = Date.now() - stat.mtimeMs;
  } catch {
    // No heartbeat file — container may never have started, or it's very old
  }

  if (heartbeatAge < STALE_THRESHOLD_MS) return; // Container is alive

  // Heartbeat is stale — check for stuck processing entries
  const processing = outDb.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
    message_id: string;
  }>;

  if (processing.length === 0) return;

  for (const { message_id } of processing) {
    const msg = inDb
      .prepare('SELECT id, tries FROM messages_in WHERE id = ? AND status = ?')
      .get(message_id, 'pending') as { id: string; tries: number } | undefined;

    if (!msg) continue;

    if (msg.tries >= MAX_TRIES) {
      inDb.prepare("UPDATE messages_in SET status = 'failed' WHERE id = ?").run(msg.id);
      log.warn('Message marked as failed after max retries', { messageId: msg.id, sessionId: session.id });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      inDb
        .prepare(
          `UPDATE messages_in SET tries = tries + 1, process_after = datetime('now', '+${backoffSec} seconds') WHERE id = ?`,
        )
        .run(msg.id);
      log.info('Reset stale message with backoff', { messageId: msg.id, tries: msg.tries, backoffMs });
    }
  }
}

/** Insert next occurrence for completed recurring messages. */
async function handleRecurrence(inDb: Database.Database, session: Session): Promise<void> {
  const completedRecurring = inDb
    .prepare("SELECT * FROM messages_in WHERE status = 'completed' AND recurrence IS NOT NULL")
    .all() as Array<{
    id: string;
    kind: string;
    content: string;
    recurrence: string;
    process_after: string | null;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
  }>;

  for (const msg of completedRecurring) {
    try {
      const { CronExpressionParser } = await import('cron-parser');
      const interval = CronExpressionParser.parse(msg.recurrence);
      const nextRun = interval.next().toISOString();
      const newId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Host uses even seq numbers
      const maxSeq = (inDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
      const nextSeq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);

      inDb
        .prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, platform_id, channel_type, thread_id, content)
           VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId,
          nextSeq,
          msg.kind,
          nextRun,
          msg.recurrence,
          msg.platform_id,
          msg.channel_type,
          msg.thread_id,
          msg.content,
        );

      // Remove recurrence from the completed message so it doesn't spawn again
      inDb.prepare('UPDATE messages_in SET recurrence = NULL WHERE id = ?').run(msg.id);

      log.info('Inserted next recurrence', { originalId: msg.id, newId, nextRun });
    } catch (err) {
      log.error('Failed to compute next recurrence', { messageId: msg.id, recurrence: msg.recurrence, err });
    }
  }
}
