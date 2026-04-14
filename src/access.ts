/**
 * Access control + approval routing.
 *
 * Privilege is user-level, not group-level. A user holds zero or more roles
 * (owner | admin) via `user_roles`, and is optionally "known" in specific
 * agent groups via `agent_group_members`. Admins are implicitly members of
 * the groups they administer.
 *
 * Sensitive actions trigger an approval flow, routed to the admin of the
 * originating agent group; if none, the owner. Approval delivery lands in
 * the approver's DM on (ideally) the same channel kind as the originating
 * request. DM resolution (including cold DMs) is handled by ensureUserDm.
 */
import { getAgentGroup } from './db/agent-groups.js';
import { isMember } from './db/agent-group-members.js';
import {
  getAdminsOfAgentGroup,
  getGlobalAdmins,
  getOwners,
  hasAdminPrivilege,
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
} from './db/user-roles.js';
import { getUser } from './db/users.js';
import { ensureUserDm } from './user-dm.js';
import type { MessagingGroup } from './types.js';

export type AccessDecision =
  | { allowed: true; reason: 'owner' | 'global_admin' | 'admin_of_group' | 'member' }
  | { allowed: false; reason: 'unknown_user' | 'not_member' };

/** Can this user interact with this agent group? */
export function canAccessAgentGroup(userId: string, agentGroupId: string): AccessDecision {
  if (!getUser(userId)) return { allowed: false, reason: 'unknown_user' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global_admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  return { allowed: false, reason: 'not_member' };
}

/** Can this user perform privileged (admin) operations on this agent group? */
export function canAdminAgentGroup(userId: string, agentGroupId: string): boolean {
  return hasAdminPrivilege(userId, agentGroupId);
}

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 *
 * The approver-picking policy is to try local admins first (they have direct
 * context for the group), then fall back to global scope.
 */
export function pickApprover(agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of getGlobalAdmins()) add(r.user_id);
  for (const r of getOwners()) add(r.user_id);

  return approvers;
}

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break rule (per model): prefer approvers reachable on the same channel
 * kind as the origin; else first in list. Resolution uses ensureUserDm,
 * which may trigger a platform openDM call on cache miss — that's how we
 * support cold DMs to users who have never messaged the bot.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  // Pass 1: approvers whose channel matches the origin (prefix on user id).
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  // Pass 2: any reachable approver, in order.
  for (const userId of approvers) {
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}

/**
 * Resolve the agent group id for a session's originating request. Used by
 * approval routing so we know which scope to pick admins from.
 */
export function agentGroupIdForSession(sessionAgentGroupId: string | null): string | null {
  if (!sessionAgentGroupId) return null;
  return getAgentGroup(sessionAgentGroupId)?.id ?? null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}
