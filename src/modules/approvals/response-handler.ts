/**
 * Handle an admin's response to an approval card.
 *
 * Two categories of pending_approvals rows exist:
 *   1. Agent-initiated actions (install_packages, request_rebuild, add_mcp_server).
 *      Fire-and-forget from the agent's perspective: we notify via chat on
 *      approve/reject, rebuild the image if applicable, then kill the container
 *      so the next wake picks up the new image.
 *   2. OneCLI credential approvals (action = 'onecli_credential'). Resolved
 *      via an in-memory Promise — see onecli-approvals.ts.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { updateContainerConfig } from '../../container-config.js';
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  // OneCLI credential approvals — resolved via in-memory Promise first.
  if (resolveOneCLIApproval(payload.questionId, payload.value)) {
    return true;
  }

  // DB-backed pending_approvals.
  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (approval.action === ONECLI_ACTION) {
    // Row exists but the in-memory resolver is gone (timer fired or process
    // was in a weird state). Nothing to do — just drop the row.
    deletePendingApproval(payload.questionId);
    return true;
  }

  await handleAgentApproval(approval, payload.value, payload.userId ?? '');
  return true;
}

async function handleAgentApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  if (!approval.session_id) {
    deletePendingApproval(approval.approval_id);
    return;
  }
  const session = getSession(approval.session_id);
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return;
  }

  const notify = (text: string): void => {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };

  if (selectedOption !== 'approve') {
    notify(`Your ${approval.action} request was rejected by admin.`);
    log.info('Approval rejected', { approvalId: approval.approval_id, action: approval.action, userId });
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);

  if (approval.action === 'install_packages') {
    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) {
      notify('install_packages approved but agent group missing.');
      return;
    }
    updateContainerConfig(agentGroup.folder, (cfg) => {
      if (payload.apt) cfg.packages.apt.push(...(payload.apt as string[]));
      if (payload.npm) cfg.packages.npm.push(...(payload.npm as string[]));
    });

    const pkgs = [...(payload.apt || []), ...(payload.npm || [])].join(', ');
    log.info('Package install approved', { approvalId: approval.approval_id, userId });
    try {
      await buildAgentGroupImage(session.agent_group_id);
      killContainer(session.id, 'rebuild applied');
      // Schedule a follow-up prompt a few seconds after kill so the host sweep
      // respawns the container on the new image and the agent verifies + reports.
      writeSessionMessage(session.agent_group_id, session.id, {
        id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: session.agent_group_id,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
          sender: 'system',
          senderId: 'system',
        }),
        processAfter: new Date(Date.now() + 5000)
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d+Z$/, ''),
      });
      log.info('Container rebuild completed (bundled with install)', { approvalId: approval.approval_id });
    } catch (e) {
      notify(
        `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Call request_rebuild to retry.`,
      );
      log.error('Bundled rebuild failed after install approval', { approvalId: approval.approval_id, err: e });
    }
  } else if (approval.action === 'request_rebuild') {
    try {
      await buildAgentGroupImage(session.agent_group_id);
      killContainer(session.id, 'rebuild applied');
      notify('Container image rebuilt. Your container will restart with the new image on the next message.');
      log.info('Container rebuild approved and completed', { approvalId: approval.approval_id, userId });
    } catch (e) {
      notify(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
      log.error('Container rebuild failed', { approvalId: approval.approval_id, err: e });
    }
  } else if (approval.action === 'add_mcp_server') {
    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) {
      notify('add_mcp_server approved but agent group missing.');
      return;
    }
    updateContainerConfig(agentGroup.folder, (cfg) => {
      cfg.mcpServers[payload.name as string] = {
        command: payload.command as string,
        args: (payload.args as string[]) || [],
        env: (payload.env as Record<string, string>) || {},
      };
    });

    killContainer(session.id, 'mcp server added');
    notify(`MCP server "${payload.name}" added. Your container will restart with it on the next message.`);
    log.info('MCP server add approved', { approvalId: approval.approval_id, userId });
  }

  deletePendingApproval(approval.approval_id);
  await wakeContainer(session);
}
