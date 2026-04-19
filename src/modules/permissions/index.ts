/**
 * Permissions module — sender resolution + access gate.
 *
 * Registers two hooks into the core router:
 *   1. setSenderResolver — runs before agent resolution. Parses the payload,
 *      derives a namespaced user id, and upserts the `users` row on first
 *      sight. Returns null when the payload doesn't carry enough to identify
 *      a sender.
 *   2. setAccessGate — runs after agent resolution. Enforces the
 *      unknown_sender_policy (strict/request_approval/public) and the
 *      owner/global-admin/scoped-admin/member access hierarchy. Records its
 *      own `dropped_messages` row on refusal (structural drops are recorded
 *      by core).
 *
 * Without this module: sender resolution is a no-op (userId=null); the
 * access gate is not registered and core defaults to allow-all.
 */
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import {
  routeInbound,
  setAccessGate,
  setSenderResolver,
  setSenderScopeGate,
  type AccessGateResult,
  type InboundEvent,
} from '../../router.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';
import { canAccessAgentGroup } from './access.js';
import { addMember } from './db/agent-group-members.js';
import {
  deletePendingSenderApproval,
  getPendingSenderApproval,
} from './db/pending-sender-approvals.js';
import { getUser, upsertUser } from './db/users.js';
import { requestSenderApproval } from './sender-approval.js';

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

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

function handleUnknownSender(
  mg: MessagingGroup,
  userId: string | null,
  agentGroupId: string,
  accessReason: string,
  event: InboundEvent,
): void {
  const parsed = safeParseContent(event.message.content);
  const senderName = parsed.sender ?? null;
  const dropRecord = {
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: userId,
    sender_name: senderName,
    reason: `unknown_sender_${mg.unknown_sender_policy}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
  };

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
    log.info('MESSAGE DROPPED — unknown sender (approval requested)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    // Fire-and-forget; pick-approver + delivery + row-insert are all async.
    // If it fails it logs internally — the user's message still stays dropped
    // either way. Requires a resolved userId (senderResolver populates users
    // row before the gate fires); if we got here without one, there's nothing
    // to identify for approval and we just stay in the "silent strict" branch.
    if (userId) {
      requestSenderApproval({
        messagingGroupId: mg.id,
        agentGroupId,
        senderIdentity: userId,
        senderName,
        event,
      }).catch((err) => log.error('Sender-approval flow threw', { err }));
    }
    return;
  }

  // 'public' should have been handled before the gate; fall through silently.
}

setSenderResolver(extractAndUpsertUser);

setAccessGate((event, userId, mg, agentGroupId): AccessGateResult => {
  // Public channels skip the access check entirely.
  if (mg.unknown_sender_policy === 'public') {
    return { allowed: true };
  }

  if (!userId) {
    handleUnknownSender(mg, null, agentGroupId, 'unknown_user', event);
    return { allowed: false, reason: 'unknown_user' };
  }

  const decision = canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) {
    return { allowed: true };
  }

  handleUnknownSender(mg, userId, agentGroupId, decision.reason, event);
  return { allowed: false, reason: decision.reason };
});

/**
 * Per-wiring sender-scope enforcement. Stricter than the messaging-group
 * `unknown_sender_policy` — a wiring can require `sender_scope='known'`
 * (explicit owner / admin / member) even on a 'public' messaging group.
 *
 * 'all' is a no-op; any sender passes. 'known' requires a userId that
 * canAccessAgentGroup accepts (owner, admin, or group member).
 */
setSenderScopeGate(
  (_event: InboundEvent, userId: string | null, _mg: MessagingGroup, agent: MessagingGroupAgent): AccessGateResult => {
    if (agent.sender_scope === 'all') return { allowed: true };
    if (!userId) return { allowed: false, reason: 'unknown_user_scope' };
    const decision = canAccessAgentGroup(userId, agent.agent_group_id);
    if (decision.allowed) return { allowed: true };
    return { allowed: false, reason: `sender_scope_${decision.reason}` };
  },
);

/**
 * Response handler for the unknown-sender approval card.
 *
 * Claim rule: questionId matches a row in pending_sender_approvals. If no
 * such row, return false so the next handler (approvals module, OneCLI,
 * interactive) gets a shot.
 *
 * Approve: add the sender to agent_group_members + re-invoke routeInbound
 * with the stored event. The second routing attempt clears the gate because
 * the user is now a member.
 *
 * Deny: delete the row (no "deny list" — a future message re-triggers a
 * fresh card per ACTION-ITEMS item 5 "no denial persistence").
 */
async function handleSenderApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingSenderApproval(payload.questionId);
  if (!row) return false;

  const approverId = payload.userId ?? row.approver_user_id;
  const approved = payload.value === 'approve';

  if (approved) {
    addMember({
      user_id: row.sender_identity,
      agent_group_id: row.agent_group_id,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
    log.info('Unknown sender approved — member added', {
      approvalId: row.id,
      senderIdentity: row.sender_identity,
      agentGroupId: row.agent_group_id,
      approverId,
    });

    // Clear the pending row BEFORE re-routing so the gate check on the
    // second attempt doesn't see the in-flight row and short-circuit.
    deletePendingSenderApproval(row.id);

    try {
      const event = JSON.parse(row.original_message) as InboundEvent;
      await routeInbound(event);
    } catch (err) {
      log.error('Failed to replay message after sender approval', { approvalId: row.id, err });
    }
    return true;
  }

  log.info('Unknown sender denied', {
    approvalId: row.id,
    senderIdentity: row.sender_identity,
    agentGroupId: row.agent_group_id,
    approverId,
  });
  deletePendingSenderApproval(row.id);
  return true;
}

registerResponseHandler(handleSenderApprovalResponse);
