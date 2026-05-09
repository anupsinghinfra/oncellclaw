/**
 * Transport-agnostic dispatcher. Both the socket server (host caller) and
 * the per-session DB poller (container caller) call dispatch() with the
 * same frame and a transport-supplied CallerContext.
 *
 * Approval gating for risky calls from the container is the only branch
 * that differs by caller. Host callers and `open` commands run inline.
 */
import { getAgentGroup } from '../db/agent-groups.js';
import { getSession } from '../db/sessions.js';
import { registerApprovalHandler, requestApproval } from '../modules/approvals/index.js';
import type { CallerContext, ErrorCode, RequestFrame, ResponseFrame } from './frame.js';
import { lookup } from './registry.js';

export async function dispatch(req: RequestFrame, ctx: CallerContext): Promise<ResponseFrame> {
  let cmd = lookup(req.command);

  // Fallback: if the full command isn't registered, trim the last
  // dash-segment and treat it as the target ID. This lets clients join
  // all positional args with dashes (e.g. `ncl groups get abc123`
  // → command "groups-get-abc123" → trim → "groups-get" + id "abc123").
  if (!cmd) {
    const idx = req.command.lastIndexOf('-');
    if (idx > 0) {
      const shortened = req.command.slice(0, idx);
      const tail = req.command.slice(idx + 1);
      const fallback = lookup(shortened);
      if (fallback) {
        cmd = fallback;
        req = { ...req, command: shortened, args: { ...req.args, id: req.args.id ?? tail } };
      }
    }
  }

  if (!cmd) {
    return err(req.id, 'unknown-command', `no command "${req.command}"`);
  }

  if (ctx.caller !== 'host' && cmd.access === 'approval') {
    const session = getSession(ctx.sessionId);
    if (!session) {
      return err(req.id, 'handler-error', 'Session not found.');
    }
    const agentGroup = getAgentGroup(ctx.agentGroupId);
    const agentName = agentGroup?.name ?? ctx.agentGroupId;

    const argSummary = Object.entries(req.args)
      .map(([k, v]) => `--${k} ${v}`)
      .join(' ');

    await requestApproval({
      session,
      agentName,
      action: 'cli_command',
      payload: { frame: { id: req.id, command: req.command, args: req.args } },
      title: `CLI: ${req.command}`,
      question: `Agent "${agentName}" wants to run:\n\`ncl ${req.command}${argSummary ? ' ' + argSummary : ''}\``,
    });

    return err(req.id, 'approval-pending', 'Approval request sent to admin. You will be notified of the result.');
  }

  let parsed: unknown;
  try {
    parsed = cmd.parseArgs(req.args);
  } catch (e) {
    return err(req.id, 'invalid-args', errMsg(e));
  }

  try {
    const data = await cmd.handler(parsed, ctx);
    return { id: req.id, ok: true, data };
  } catch (e) {
    return err(req.id, 'handler-error', errMsg(e));
  }
}

registerApprovalHandler('cli_command', async ({ session, payload, userId, notify }) => {
  const frame = payload.frame as RequestFrame;
  const response = await dispatch(frame, { caller: 'host' });

  if (response.ok) {
    const data = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
    notify(`Your \`ncl ${frame.command}\` request was approved and executed.\n\n${data}`);
  } else {
    notify(`Your \`ncl ${frame.command}\` request was approved but failed: ${response.error.message}`);
  }
});

function err(id: string, code: ErrorCode, message: string): ResponseFrame {
  return { id, ok: false, error: { code, message } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
