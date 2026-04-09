/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { getRunningSessions, getActiveSessions, createPendingQuestion } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, sessionDir, inboundDbPath } from './session-manager.js';
import { resetContainerIdleTimer } from './container-runner.js';
import type { OutboundFile } from './channels/adapter.js';
import type { Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<void>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
}

/** Show typing indicator on a channel. Called when a message is routed to the agent. */
export async function triggerTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
  try {
    await deliveryAdapter?.setTyping?.(channelType, platformId, threadId);
  } catch {
    // Typing is best-effort — don't fail routing if it errors
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

async function deliverSessionMessages(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = outDb
      .prepare(
        `SELECT * FROM messages_out
         WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
         ORDER BY timestamp ASC`,
      )
      .all() as Array<{
      id: string;
      kind: string;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      content: string;
    }>;

    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const deliveredIds = new Set(
      (inDb.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>).map(
        (r) => r.message_out_id,
      ),
    );
    const undelivered = allDue.filter((m) => !deliveredIds.has(m.id));
    if (undelivered.length === 0) return;

    for (const msg of undelivered) {
      try {
        await deliverMessage(msg, session, inDb);
        // Track delivery in inbound.db (host-owned) — not outbound.db
        inDb
          .prepare("INSERT OR IGNORE INTO delivered (message_out_id, delivered_at) VALUES (?, datetime('now'))")
          .run(msg.id);
        resetContainerIdleTimer(session.id);
      } catch (err) {
        log.error('Failed to deliver message', { messageId: msg.id, sessionId: session.id, err });
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
  },
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — route to target session
  if (msg.channel_type === 'agent') {
    log.info('Agent-to-agent message', { from: session.id, target: msg.platform_id });
    // TODO: route to target agent's session DB
    return;
  }

  // Track pending questions for ask_user_question flow
  if (content.type === 'ask_question' && content.questionId) {
    createPendingQuestion({
      question_id: content.questionId,
      session_id: session.id,
      message_out_id: msg.id,
      platform_id: msg.platform_id,
      channel_type: msg.channel_type,
      thread_id: msg.thread_id,
      created_at: new Date().toISOString(),
    });
    log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files
  let files: OutboundFile[] | undefined;
  const outboxDir = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', msg.id);
  if (Array.isArray(content.files) && content.files.length > 0 && fs.existsSync(outboxDir)) {
    files = [];
    for (const filename of content.files as string[]) {
      const filePath = path.join(outboxDir, filename);
      if (fs.existsSync(filePath)) {
        files.push({ filename, data: fs.readFileSync(filePath) });
      } else {
        log.warn('Outbox file not found', { messageId: msg.id, filename });
      }
    }
    if (files.length === 0) files = undefined;
  }

  await deliveryAdapter.deliver(msg.channel_type, msg.platform_id, msg.thread_id, msg.kind, msg.content, files);
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    fileCount: files?.length,
  });

  // Clean up outbox directory after successful delivery
  if (fs.existsSync(outboxDir)) {
    fs.rmSync(outboxDir, { recursive: true, force: true });
  }
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  switch (action) {
    case 'schedule_task': {
      const taskId = content.taskId as string;
      const prompt = content.prompt as string;
      const script = content.script as string | null;
      const processAfter = content.processAfter as string;
      const recurrence = (content.recurrence as string) || null;

      // Compute next even seq for host-owned inbound.db
      const maxSeq = (inDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
      const nextSeq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);

      inDb
        .prepare(
          `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content)
           VALUES (@id, @seq, datetime('now'), 'pending', 0, @process_after, @recurrence, 'task', @platform_id, @channel_type, @thread_id, @content)`,
        )
        .run({
          id: taskId,
          seq: nextSeq,
          process_after: processAfter,
          recurrence,
          platform_id: content.platformId ?? null,
          channel_type: content.channelType ?? null,
          thread_id: content.threadId ?? null,
          content: JSON.stringify({ prompt, script }),
        });
      log.info('Scheduled task created', { taskId, processAfter, recurrence });
      break;
    }

    case 'cancel_task': {
      const taskId = content.taskId as string;
      inDb
        .prepare(
          "UPDATE messages_in SET status = 'completed' WHERE id = ? AND kind = 'task' AND status IN ('pending', 'paused')",
        )
        .run(taskId);
      log.info('Task cancelled', { taskId });
      break;
    }

    case 'pause_task': {
      const taskId = content.taskId as string;
      inDb
        .prepare("UPDATE messages_in SET status = 'paused' WHERE id = ? AND kind = 'task' AND status = 'pending'")
        .run(taskId);
      log.info('Task paused', { taskId });
      break;
    }

    case 'resume_task': {
      const taskId = content.taskId as string;
      inDb
        .prepare("UPDATE messages_in SET status = 'pending' WHERE id = ? AND kind = 'task' AND status = 'paused'")
        .run(taskId);
      log.info('Task resumed', { taskId });
      break;
    }

    default:
      log.warn('Unknown system action', { action });
  }
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
