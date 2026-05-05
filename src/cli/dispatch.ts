/**
 * Transport-agnostic dispatcher. Both the socket server (host caller) and
 * the per-session DB poller (container caller) call dispatch() with the
 * same frame and a transport-supplied CallerContext.
 *
 * Approval gating for risky calls from the container is the only branch
 * that differs by caller. Host callers and `open` commands run inline.
 */
import type { CallerContext, ErrorCode, RequestFrame, ResponseFrame } from './frame.js';
import { lookup } from './registry.js';

export async function dispatch(req: RequestFrame, ctx: CallerContext): Promise<ResponseFrame> {
  const cmd = lookup(req.command);
  if (!cmd) {
    return err(req.id, 'unknown-command', `no command "${req.command}"`);
  }

  // Agent + approval-gated → approval flow. Wired alongside the first
  // approval-requiring command; until then, return a clear error.
  if (ctx.caller !== 'host' && cmd.access === 'approval') {
    return err(req.id, 'approval-pending', 'This command requires approval. (Approval flow not yet wired.)');
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

function err(id: string, code: ErrorCode, message: string): ResponseFrame {
  return { id, ok: false, error: { code, message } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
