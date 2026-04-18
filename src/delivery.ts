/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getRunningSessions, getActiveSessions, createPendingQuestion, getSession } from './db/sessions.js';
import { getAgentGroup, createAgentGroup, updateAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { createDestination, getDestinationByName, hasDestination, normalizeName } from './db/agent-destinations.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import {
  getDueOutboundMessages,
  getDeliveredIds,
  markDelivered,
  markDeliveryFailed,
  migrateDeliveredTable,
  insertTask,
  cancelTask,
  pauseTask,
  resumeTask,
  updateTask,
} from './db/session-db.js';
import { log } from './log.js';
import { normalizeOptions } from './channels/ask-question.js';
import {
  openInboundDb,
  openOutboundDb,
  sessionDir,
  resolveSession,
  writeDestinations,
  writeSessionMessage,
} from './session-manager.js';
import { resetContainerIdleTimer, wakeContainer } from './container-runner.js';
import { initGroupFilesystem } from './group-init.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import type { OutboundFile } from './channels/adapter.js';
import type { AgentGroup, Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** Track delivery attempt counts. Resets on process restart (gives failed messages a fresh chance). */
const deliveryAttempts = new Map<string, number>();

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Set<string>();

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/**
 * Deliver a system notification to an agent as a regular chat message.
 * Used for fire-and-forget responses from host actions (create_agent result,
 * approval outcomes, etc.). The agent sees it as an inbound chat message
 * with sender="system".
 */
function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  // Wake the container so it picks up the notification promptly
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
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

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
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
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);
        resetContainerIdleTimer(session.id);

        // Pause the typing indicator after a real user-facing message
        // lands on the user's screen, so the client has time to visually
        // clear the indicator before the next heartbeat tick brings it
        // back. Skip the pause for internal traffic (system actions,
        // agent-to-agent routing) — the user doesn't see those and
        // shouldn't get a gap in their typing indicator for them.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          deliveryAttempts.delete(msg.id);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
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
): Promise<string | undefined> {
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

  // Agent-to-agent — route to target session (with permission check).
  // Permission is enforced via agent_destinations — the source agent must have
  // a row for the target. Content is copied verbatim; the target's formatter
  // will look up the source agent in its own local map to display a name.
  if (msg.channel_type === 'agent') {
    const targetAgentGroupId = msg.platform_id;
    if (!targetAgentGroupId) {
      throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
    }
    // Self-messages are always allowed — used for system notes injected back
    // into an agent's own session (e.g. post-approval follow-up prompts).
    if (
      targetAgentGroupId !== session.agent_group_id &&
      !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
    ) {
      throw new Error(
        `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
      );
    }
    if (!getAgentGroup(targetAgentGroupId)) {
      throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
    }
    const { session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
    writeSessionMessage(targetAgentGroupId, targetSession.id, {
      id: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: msg.content,
    });
    log.info('Agent message routed', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      targetSession: targetSession.id,
    });
    const fresh = getSession(targetSession.id);
    if (fresh) await wakeContainer(fresh);
    return;
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  if (msg.channel_type && msg.platform_id) {
    const mg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg) {
      throw new Error(`unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`);
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless).
    const checkDestinations = hasTable(getDb(), 'agent_destinations');
    if (!isOriginChat && checkDestinations && !hasDestination(session.agent_group_id, 'channel', mg.id)) {
      throw new Error(
        `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
      );
    }
  }

  // Track pending questions for ask_user_question flow.
  // Guarded: without the interactive module, `pending_questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && hasTable(getDb(), 'pending_questions')) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        title,
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
    }
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

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    msg.content,
    files,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  // Clean up outbox best-effort — the message is already on the user's
  // screen, so a cleanup failure must NOT propagate. If it did, the
  // caller would treat the whole delivery as failed, retry on the next
  // poll, and the user would see the message twice.
  if (fs.existsSync(outboxDir)) {
    try {
      fs.rmSync(outboxDir, { recursive: true, force: true });
    } catch (err) {
      log.warn('Outbox cleanup failed (message already delivered)', { messageId: msg.id, err });
    }
  }

  return platformMsgId;
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Core checks the registry first in
 * `handleSystemAction` and falls through to the inline switch when no
 * handler is registered. The switch will shrink as modules are extracted
 * (scheduling, approvals, agent-to-agent) and eventually only its default
 * branch remains.
 *
 * Default when no handler registered and the switch doesn't match: log
 * "Unknown system action" and return.
 */
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<void>;

const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) {
    log.warn('Delivery action handler overwritten', { action });
  }
  actionHandlers.set(action, handler);
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

  const registered = actionHandlers.get(action);
  if (registered) {
    await registered(content, session, inDb);
    return;
  }

  switch (action) {
    case 'schedule_task': {
      const taskId = content.taskId as string;
      const prompt = content.prompt as string;
      const script = content.script as string | null;
      const processAfter = content.processAfter as string;
      const recurrence = (content.recurrence as string) || null;

      insertTask(inDb, {
        id: taskId,
        processAfter,
        recurrence,
        platformId: (content.platformId as string) ?? null,
        channelType: (content.channelType as string) ?? null,
        threadId: (content.threadId as string) ?? null,
        content: JSON.stringify({ prompt, script }),
      });
      log.info('Scheduled task created', { taskId, processAfter, recurrence });
      break;
    }

    case 'cancel_task': {
      const taskId = content.taskId as string;
      cancelTask(inDb, taskId);
      log.info('Task cancelled', { taskId });
      break;
    }

    case 'pause_task': {
      const taskId = content.taskId as string;
      pauseTask(inDb, taskId);
      log.info('Task paused', { taskId });
      break;
    }

    case 'resume_task': {
      const taskId = content.taskId as string;
      resumeTask(inDb, taskId);
      log.info('Task resumed', { taskId });
      break;
    }

    case 'update_task': {
      const taskId = content.taskId as string;
      const update: Parameters<typeof updateTask>[2] = {};
      if (typeof content.prompt === 'string') update.prompt = content.prompt;
      if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
      if (content.recurrence === null || typeof content.recurrence === 'string') {
        update.recurrence = content.recurrence as string | null;
      }
      if (content.script === null || typeof content.script === 'string') {
        update.script = content.script as string | null;
      }
      const touched = updateTask(inDb, taskId, update);
      log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
      if (touched === 0) {
        notifyAgent(session, `update_task: no live task matched id "${taskId}".`);
      }
      break;
    }

    case 'create_agent': {
      const requestId = content.requestId as string;
      const name = content.name as string;
      const instructions = content.instructions as string | null;

      const sourceGroup = getAgentGroup(session.agent_group_id);
      if (!sourceGroup) {
        notifyAgent(session, `create_agent failed: source agent group not found.`);
        log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
        break;
      }

      const localName = normalizeName(name);

      // Collision in the creator's destination namespace
      if (getDestinationByName(sourceGroup.id, localName)) {
        notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
        break;
      }

      // Derive a safe folder name, deduplicated globally across agent_groups.folder
      let folder = localName;
      let suffix = 2;
      while (getAgentGroupByFolder(folder)) {
        folder = `${localName}-${suffix}`;
        suffix++;
      }

      const groupPath = path.join(GROUPS_DIR, folder);
      const resolvedPath = path.resolve(groupPath);
      const resolvedGroupsDir = path.resolve(GROUPS_DIR);
      if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
        notifyAgent(session, `Cannot create agent "${name}": invalid folder path.`);
        log.error('create_agent path traversal attempt', { folder, resolvedPath });
        break;
      }

      const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const newGroup: AgentGroup = {
        id: agentGroupId,
        name,
        folder,
        agent_provider: null,
        created_at: now,
      };
      createAgentGroup(newGroup);
      initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });

      // Insert bidirectional destination rows (= ACL grants).
      // Creator refers to child by the name it chose; child refers to creator as "parent".
      createDestination({
        agent_group_id: sourceGroup.id,
        local_name: localName,
        target_type: 'agent',
        target_id: agentGroupId,
        created_at: now,
      });
      // Handle the unlikely case where the child already has a "parent" destination
      // (shouldn't happen for a brand-new agent, but be safe).
      let parentName = 'parent';
      let parentSuffix = 2;
      while (getDestinationByName(agentGroupId, parentName)) {
        parentName = `parent-${parentSuffix}`;
        parentSuffix++;
      }
      createDestination({
        agent_group_id: agentGroupId,
        local_name: parentName,
        target_type: 'agent',
        target_id: sourceGroup.id,
        created_at: now,
      });

      // REQUIRED: project the new destination into the running
      // container's inbound.db. See the top-of-file invariant in
      // src/db/agent-destinations.ts — forgetting this causes
      // "dropped: unknown destination" when the parent tries to send
      // to the newly-created child.
      writeDestinations(session.agent_group_id, session.id);

      // Fire-and-forget notification back to the creator
      notifyAgent(
        session,
        `Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.`,
      );
      log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
      // Note: requestId is unused — this is fire-and-forget, not request/response.
      void requestId;
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
