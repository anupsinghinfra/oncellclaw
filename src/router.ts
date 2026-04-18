/**
 * Inbound message routing for v2.
 *
 * Channel adapter event → resolve messaging group → access gate → resolve
 * agent group → resolve/create session → write messages_in → wake container.
 *
 * Privilege / access model:
 *   - Owners and global admins: always allowed
 *   - Scoped admins: allowed in their agent group
 *   - Known members (agent_group_members row): allowed in that agent group
 *   - Everyone else: message is dropped per `messaging_groups.unknown_sender_policy`
 *     (strict / request_approval / public)
 *
 * Sender normalization: we derive a namespaced user id from the message
 * content. This is best-effort — native adapters put `sender` in content,
 * chat-sdk-bridge adapters put `senderId`. Adapters should populate both
 * wherever possible so the gate can land on a real user row.
 */
import { canAccessAgentGroup } from './access.js';
import { getChannelAdapter } from './channels/channel-registry.js';
import { isMember } from './db/agent-group-members.js';
import { getMessagingGroupByPlatform, createMessagingGroup, getMessagingGroupAgents } from './db/messaging-groups.js';
import { upsertUser, getUser } from './db/users.js';
import { startTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface InboundEvent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  message: {
    id: string;
    kind: 'chat' | 'chat-sdk';
    content: string; // JSON blob
    timestamp: string;
  };
}

/**
 * Inbound gate registry.
 *
 * A module (permissions, today) can register a single gate function that
 * owns sender resolution + access decision. Without a registered gate,
 * core falls back to the inline `extractAndUpsertUser` +
 * `enforceAccess` + `handleUnknownSender` chain.
 *
 * Takes the raw event so the gate can read sender fields from
 * `event.message.content`. Returns either allowed=true with a `userId`
 * (null if unresolved) or allowed=false with a reason; core drops the
 * message on refusal.
 */
export type InboundGateResult =
  | { allowed: true; userId: string | null }
  | { allowed: false; userId: string | null; reason: string };

export type InboundGateFn = (event: InboundEvent, mg: MessagingGroup, agentGroupId: string) => InboundGateResult;

let inboundGate: InboundGateFn | null = null;

export function setInboundGate(fn: InboundGateFn): void {
  if (inboundGate) {
    log.warn('Inbound gate overwritten');
  }
  inboundGate = fn;
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel — the
  //    agent always replies to the main channel regardless of where the
  //    inbound came from.
  const adapter = getChannelAdapter(event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  // 1. Resolve messaging group
  let mg = getMessagingGroupByPlatform(event.channelType, event.platformId);

  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
  }

  // 2. Resolve agent groups wired to this messaging group. (The gate runs
  //    after this so it can decide based on the target agent group.)
  const agents = getMessagingGroupAgents(mg.id);
  if (agents.length === 0) {
    log.warn('MESSAGE DROPPED — no agent groups wired to this channel. Run setup register step to configure.', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: parsed.senderId ?? null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
    return;
  }

  // Pick the best matching agent (highest priority, trigger matching in future)
  const match = pickAgent(agents, event);
  if (!match) {
    log.warn('MESSAGE DROPPED — no agent matched trigger rules', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
    });
    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: parsed.senderId ?? null,
      sender_name: parsed.sender ?? null,
      reason: 'no_trigger_match',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
    return;
  }

  // 3. Inbound gate: sender resolution + access decision. If a module
  //    registered a gate, it owns the whole thing (it can upsert users,
  //    check roles, etc.). Otherwise fall back to the inline chain.
  let userId: string | null;
  if (inboundGate) {
    const result = inboundGate(event, mg, match.agent_group_id);
    userId = result.userId;
    if (!result.allowed) {
      log.info('MESSAGE DROPPED — inbound gate refused', {
        messagingGroupId: mg.id,
        agentGroupId: match.agent_group_id,
        userId,
        reason: result.reason,
      });
      return;
    }
  } else {
    userId = extractAndUpsertUser(event);
    if (mg.unknown_sender_policy !== 'public') {
      const gate = enforceAccess(userId, match.agent_group_id);
      if (!gate.allowed) {
        handleUnknownSender(mg, userId, match.agent_group_id, gate.reason, event);
        return;
      }
    }
  }

  // 5. Resolve or create session.
  //
  // Adapter thread policy overrides the wiring's session_mode: if the adapter
  // is threaded, each thread gets its own session regardless of what the
  // wiring says, because "thread = session" is the first-class model for
  // threaded platforms. Agent-shared is preserved because it expresses a
  // cross-channel intent the adapter can't know about.
  //
  // Exception: DMs (is_group=0). Sub-threads within a DM are a UX affordance,
  // not a conversation boundary — treat the whole DM as one session and let
  // threadId flow through to delivery so replies land in the right sub-thread.
  let effectiveSessionMode = match.session_mode;
  if (adapter && adapter.supportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }
  const { session, created } = resolveSession(match.agent_group_id, mg.id, event.threadId, effectiveSessionMode);

  // 6. Write message to session DB
  writeSessionMessage(session.agent_group_id, session.id, {
    id: event.message.id || generateId(),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: event.platformId,
    channelType: event.channelType,
    threadId: event.threadId,
    content: event.message.content,
  });

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: match.agent_group_id,
    kind: event.message.kind,
    userId,
    created,
  });

  // 7. Show typing indicator while the agent processes. Refresh on a short
  // interval so platforms like Discord (which auto-expire typing after
  // ~10s) keep showing it for the full thinking window. Gated on the
  // heartbeat file's mtime after an initial grace period, so typing stops
  // as soon as the agent goes idle — not when the container eventually
  // exits. Container-runner also calls stopTypingRefresh on exit as a
  // fast-path cleanup.
  startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);

  // 8. Wake container
  const freshSession = getSession(session.id);
  if (freshSession) {
    await wakeContainer(freshSession);
  }
}

/**
 * Pick the matching agent for an inbound event.
 * Currently: highest priority agent. Future: trigger rule matching.
 */
function pickAgent(agents: MessagingGroupAgent[], _event: InboundEvent): MessagingGroupAgent | null {
  // Agents are already ordered by priority DESC from the DB query
  // TODO: apply trigger_rules matching (pattern, mentionOnly, etc.)
  return agents[0] ?? null;
}

/**
 * Best-effort sender extraction. Returns a namespaced user id like
 * `telegram:123` or null if nothing usable is present.
 *
 * Side-effect: upserts the user into the `users` table so access/approval
 * lookups can find them on subsequent messages.
 *
 * The namespace uses the channel_type as `kind` for now — e.g. `whatsapp:...`
 * rather than `phone:...`. That's imprecise (a phone number is really the
 * identifier, not the channel) but it keeps the first cut simple. A proper
 * kind mapping (channel → kind) can happen when we start linking identities
 * across channels.
 */
function extractAndUpsertUser(event: InboundEvent): string | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }

  // chat-sdk-bridge serializes author info as a nested `author.userId` and
  // does NOT populate top-level `senderId`. Older adapters (v1, native) put
  // `senderId` or `sender` directly at the top level. Check all three.
  const senderIdField = typeof content.senderId === 'string' ? content.senderId : undefined;
  const senderField = typeof content.sender === 'string' ? content.sender : undefined;
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const authorUserId = typeof author?.userId === 'string' ? (author.userId as string) : undefined;
  const senderName =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
    (typeof author?.userName === 'string' ? (author.userName as string) : undefined);

  const rawHandle = senderIdField ?? senderField ?? authorUserId;
  if (!rawHandle) return null;

  // If the raw handle already contains ':' it's pre-namespaced (the older
  // adapters put it in that form). Otherwise prepend the channel type.
  const userId = rawHandle.includes(':') ? rawHandle : `${event.channelType}:${rawHandle}`;
  if (!getUser(userId)) {
    upsertUser({
      id: userId,
      kind: event.channelType,
      display_name: senderName ?? null,
      created_at: new Date().toISOString(),
    });
  }
  return userId;
}

function enforceAccess(userId: string | null, agentGroupId: string): { allowed: boolean; reason: string } {
  if (!userId) return { allowed: false, reason: 'unknown_user' };
  const decision = canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) return { allowed: true, reason: decision.reason };
  return { allowed: false, reason: decision.reason };
}

function handleUnknownSender(
  mg: MessagingGroup,
  userId: string | null,
  agentGroupId: string,
  accessReason: string,
  event: InboundEvent,
): void {
  const parsed = safeParseContent(event.message.content);
  const dropRecord = {
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: userId,
    sender_name: parsed.sender ?? null,
    reason: `unknown_sender_${mg.unknown_sender_policy}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
  };

  // In 'strict' mode we just drop. In 'request_approval' mode we log and
  // queue an approval to add the sender as a member — the approval flow
  // itself is a follow-up (needs an action kind like `add_group_member`).
  if (mg.unknown_sender_policy === 'strict') {
    log.info('MESSAGE DROPPED — unknown sender (strict policy)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    return;
  }

  if (mg.unknown_sender_policy === 'request_approval') {
    log.info('MESSAGE DROPPED — unknown sender (approval flow TODO)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    return;
  }

  // Should be unreachable — 'public' was handled before the gate.
  // Ensure the membership invariant isn't in an odd state.
  void isMember;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}
