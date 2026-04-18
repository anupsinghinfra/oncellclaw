/**
 * Delivery-action handlers for agent-initiated approval requests.
 *
 * Three actions the container can write into messages_out (via self-mod
 * MCP tools): install_packages, request_rebuild, add_mcp_server. Each one
 * delivers an approval card to an admin's DM and records a pending_approvals
 * row. The admin clicks a button → handleApprovalResponse picks it up.
 *
 * Host-side sanitization for install_packages is defense-in-depth (the MCP
 * tool validates first). Both layers matter — the DB row and eventual
 * shell-exec trust it.
 */
import { pickApprovalDelivery, pickApprover } from '../../access.js';
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];

/** Inline copy of delivery.ts's notifyAgent — sends a system chat to the agent. */
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
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

/**
 * Send an approval request to a privileged user's DM and record a
 * pending_approval row. Routing: admin @ originating agent group → owner.
 * Tie-break: prefer an approver reachable on the same channel kind as the
 * originating session's messaging group. Delivery always lands in the
 * approver's DM (not the origin group), regardless of where the action
 * was triggered.
 */
async function requestApproval(
  session: Session,
  agentName: string,
  action: 'install_packages' | 'request_rebuild' | 'add_mcp_server',
  payload: Record<string, unknown>,
  title: string,
  question: string,
): Promise<void> {
  const approvers = pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return;
  }

  const originChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
    return;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(normalizedOptions),
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options: APPROVAL_OPTIONS,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to ${target.userId}.`);
      return;
    }
  }

  log.info('Approval requested', { action, approvalId, agentName, approver: target.userId });
}

export async function handleInstallPackages(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages failed: agent group not found.');
    return;
  }

  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];
  const reason = (content.reason as string) || '';

  const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
  const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const MAX_PACKAGES = 20;
  if (apt.length + npm.length === 0) {
    notifyAgent(session, 'install_packages failed: at least one apt or npm package is required.');
    return;
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    notifyAgent(session, `install_packages failed: max ${MAX_PACKAGES} packages per request.`);
    return;
  }
  const invalidApt = apt.find((p) => !APT_RE.test(p));
  if (invalidApt) {
    notifyAgent(session, `install_packages failed: invalid apt package name "${invalidApt}".`);
    log.warn('install_packages: invalid apt package rejected', { pkg: invalidApt });
    return;
  }
  const invalidNpm = npm.find((p) => !NPM_RE.test(p));
  if (invalidNpm) {
    notifyAgent(session, `install_packages failed: invalid npm package name "${invalidNpm}".`);
    log.warn('install_packages: invalid npm package rejected', { pkg: invalidNpm });
    return;
  }

  const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
  await requestApproval(
    session,
    agentGroup.name,
    'install_packages',
    { apt, npm, reason },
    'Install Packages Request',
    `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
  );
}

export async function handleRequestRebuild(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'request_rebuild failed: agent group not found.');
    return;
  }
  const reason = (content.reason as string) || '';
  await requestApproval(
    session,
    agentGroup.name,
    'request_rebuild',
    { reason },
    'Rebuild Request',
    `Agent "${agentGroup.name}" is attempting to rebuild container.${reason ? `\nReason: ${reason}` : ''}`,
  );
}

export async function handleAddMcpServer(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return;
  }
  const serverName = content.name as string;
  const command = content.command as string;
  if (!serverName || !command) {
    notifyAgent(session, 'add_mcp_server failed: name and command are required.');
    return;
  }
  await requestApproval(
    session,
    agentGroup.name,
    'add_mcp_server',
    {
      name: serverName,
      command,
      args: (content.args as string[]) || [],
      env: (content.env as Record<string, string>) || {},
    },
    'Add MCP Request',
    `Agent "${agentGroup.name}" is attempting to add a new MCP server:\n${serverName} (${command})`,
  );
}
