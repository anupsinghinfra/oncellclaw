/**
 * Credential collection flow.
 *
 * Agent calls `trigger_credential_collection` — container writes a system
 * action `request_credential` into outbound.db. This module:
 *
 *   1. Delivers an `[Enter credential] [Reject]` card to the admin channel.
 *   2. On "Enter credential" click, the Chat SDK bridge opens a modal with a
 *      TextInput, captures the user's value in `onModalSubmit`, and calls
 *      `handleCredentialSubmit()` here.
 *   3. We insert the secret into OneCLI and write a system chat message into
 *      the agent's session DB so the blocking MCP tool call returns.
 *   4. The credential value never enters any session DB or log line.
 */
import {
  createPendingCredential,
  deletePendingCredential,
  getPendingCredential as getPendingCredentialRow,
  updatePendingCredentialMessageId,
  updatePendingCredentialStatus,
} from './db/credentials.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { createSecret, OneCLISecretError } from './onecli-secrets.js';
import { writeSessionMessage } from './session-manager.js';
import type { PendingCredential, Session } from './types.js';
import { wakeContainer } from './container-runner.js';

let adapterRef: ChannelDeliveryAdapter | null = null;

export function setCredentialDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  adapterRef = adapter;
}

/** Handle a `request_credential` system action from a container. */
export async function handleCredentialRequest(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  if (!adapterRef) {
    notifyAgentCredentialResult(session, content.credentialId as string, 'failed', 'delivery adapter not ready');
    return;
  }

  const credentialId = (content.credentialId as string) || '';
  const name = (content.name as string) || '';
  const type = ((content.type as string) || 'generic') as 'generic' | 'anthropic';
  const hostPattern = (content.hostPattern as string) || '';
  const pathPattern = (content.pathPattern as string) || null;
  const headerName = (content.headerName as string) || null;
  const valueFormat = (content.valueFormat as string) || null;
  const description = (content.description as string) || null;

  if (!credentialId || !name || !hostPattern) {
    notifyAgentCredentialResult(
      session,
      credentialId,
      'failed',
      'name and hostPattern are required',
    );
    return;
  }

  // Deliver the credential card to the channel where the conversation is
  // happening — not the admin channel. The user triggered this request by
  // chatting with the agent, so the response surface is their chat channel.
  if (!session.messaging_group_id) {
    notifyAgentCredentialResult(
      session,
      credentialId,
      'failed',
      'session has no messaging group — cannot deliver credential card',
    );
    return;
  }
  const mg = getMessagingGroup(session.messaging_group_id);
  if (!mg) {
    notifyAgentCredentialResult(session, credentialId, 'failed', 'messaging group not found');
    return;
  }

  createPendingCredential({
    id: credentialId,
    agent_group_id: session.agent_group_id,
    session_id: session.id,
    name,
    type,
    host_pattern: hostPattern,
    path_pattern: pathPattern,
    header_name: headerName,
    value_format: valueFormat,
    description,
    channel_type: mg.channel_type,
    platform_id: mg.platform_id,
    platform_message_id: null,
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  const question = buildCardText({
    name,
    hostPattern,
    headerName,
    valueFormat,
    description,
  });

  let platformMessageId: string | undefined;
  try {
    platformMessageId = await adapterRef.deliver(
      mg.channel_type,
      mg.platform_id,
      session.thread_id,
      'chat-sdk',
      JSON.stringify({
        type: 'credential_request',
        credentialId,
        question,
      }),
    );
  } catch (err) {
    log.error('Failed to deliver credential request card', { credentialId, err });
    updatePendingCredentialStatus(credentialId, 'failed');
    notifyAgentCredentialResult(session, credentialId, 'failed', 'could not deliver card');
    return;
  }

  if (platformMessageId) {
    updatePendingCredentialMessageId(credentialId, platformMessageId);
  }

  log.info('Credential request delivered', { credentialId, name, hostPattern });
}

/** Called by chat-sdk-bridge to fetch metadata for building the modal. */
export function getCredentialForModal(
  credentialId: string,
): { name: string; description: string | null; hostPattern: string } | null {
  const row = getPendingCredentialRow(credentialId);
  if (!row || row.status !== 'pending') return null;
  return { name: row.name, description: row.description, hostPattern: row.host_pattern };
}

/** Admin clicked "Reject" on the card (or cancelled the modal). */
export async function handleCredentialReject(credentialId: string): Promise<void> {
  const row = getPendingCredentialRow(credentialId);
  if (!row) return;
  updatePendingCredentialStatus(credentialId, 'rejected');

  if (row.session_id) {
    await notifyAgentSessionResult(
      row.agent_group_id,
      row.session_id,
      credentialId,
      'rejected',
      `Credential request for ${row.name} was rejected by admin.`,
    );
  }

  deletePendingCredential(credentialId);
  log.info('Credential request rejected', { credentialId });
}

/**
 * Admin submitted the modal with a credential value.
 * The value is held only long enough to call OneCLI and is then dropped.
 */
export async function handleCredentialSubmit(credentialId: string, value: string): Promise<void> {
  const row = getPendingCredentialRow(credentialId);
  if (!row) {
    log.warn('Credential submit for unknown id', { credentialId });
    return;
  }
  if (row.status !== 'pending') {
    log.warn('Credential submit for non-pending row', { credentialId, status: row.status });
    return;
  }

  updatePendingCredentialStatus(credentialId, 'submitted');

  try {
    await createSecret({
      name: row.name,
      type: row.type,
      value,
      hostPattern: row.host_pattern,
      pathPattern: row.path_pattern ?? undefined,
      headerName: row.header_name ?? undefined,
      valueFormat: row.value_format ?? undefined,
      agentId: row.agent_group_id, // honored once OneCLI SDK adds scoping
    });
  } catch (err) {
    const reason = err instanceof OneCLISecretError ? err.message : String(err);
    log.error('Failed to create OneCLI secret', { credentialId, reason });
    updatePendingCredentialStatus(credentialId, 'failed');
    if (row.session_id) {
      await notifyAgentSessionResult(
        row.agent_group_id,
        row.session_id,
        credentialId,
        'failed',
        `Credential save failed: ${reason}`,
      );
    }
    deletePendingCredential(credentialId);
    return;
  }

  updatePendingCredentialStatus(credentialId, 'saved');
  log.info('Credential saved', { credentialId, name: row.name, hostPattern: row.host_pattern });

  if (row.session_id) {
    await notifyAgentSessionResult(
      row.agent_group_id,
      row.session_id,
      credentialId,
      'saved',
      `Credential "${row.name}" saved (host pattern: ${row.host_pattern}).`,
    );
  }

  deletePendingCredential(credentialId);
}

/**
 * Fallback for inbound channels that don't support modals — the bridge calls
 * this when `event.openModal()` is unavailable or returned undefined.
 */
export async function handleCredentialChannelUnsupported(credentialId: string): Promise<void> {
  const row = getPendingCredentialRow(credentialId);
  if (!row) return;
  updatePendingCredentialStatus(credentialId, 'failed');
  if (row.session_id) {
    await notifyAgentSessionResult(
      row.agent_group_id,
      row.session_id,
      credentialId,
      'failed',
      `This channel doesn't support credential collection modals. Use Slack, Discord, Teams, or Google Chat.`,
    );
  }
  deletePendingCredential(credentialId);
}

function notifyAgentCredentialResult(
  session: Session,
  credentialId: string,
  status: 'saved' | 'rejected' | 'failed',
  detail: string,
): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `cred-${credentialId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      type: 'credential_response',
      credentialId,
      status,
      detail,
    }),
  });
}

async function notifyAgentSessionResult(
  agentGroupId: string,
  sessionId: string,
  credentialId: string,
  status: 'saved' | 'rejected' | 'failed',
  detail: string,
): Promise<void> {
  writeSessionMessage(agentGroupId, sessionId, {
    id: `cred-${credentialId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: agentGroupId,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      type: 'credential_response',
      credentialId,
      status,
      detail,
    }),
  });

  const { getSession } = await import('./db/sessions.js');
  const session = getSession(sessionId);
  if (session) await wakeContainer(session);
}

function buildCardText(opts: {
  name: string;
  hostPattern: string;
  headerName: string | null;
  valueFormat: string | null;
  description: string | null;
}): string {
  const lines = [
    `🔑 Credential request: ${opts.name}`,
    '',
    `Host: \`${opts.hostPattern}\``,
  ];
  if (opts.headerName) lines.push(`Header: \`${opts.headerName}\``);
  if (opts.valueFormat) lines.push(`Format: \`${opts.valueFormat}\``);
  if (opts.description) lines.push('', opts.description);
  lines.push('', 'Click Enter credential to provide the value, or Reject to decline.');
  return lines.join('\n');
}
