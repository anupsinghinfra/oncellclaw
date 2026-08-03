/**
 * WhatsApp QR pairing relay — hosted claws pair by scanning the Baileys QR
 * in the dashboard instead of a terminal.
 *
 * One canonical pairing path however the QR is displayed: the trunk-maintained
 * setup step (`setup/whatsapp-auth.ts`) runs Baileys and emits each rotating
 * QR as a structured status block on stdout (`WHATSAPP_AUTH_QR { QR }`,
 * terminal `WHATSAPP_AUTH { STATUS }` — see that file's header). This module
 * spawns the same command the `.claude/skills/add-whatsapp` browser helper
 * spawns, parses the same blocks, and holds the current QR for
 * `GET /web/channels/whatsapp/qr` (src/channels/web.ts) to serve — JSON
 * snapshot or SSE stream — until the phone scans it.
 *
 * What a successful scan produces: a linked-device session under `store/auth`
 * (src/channels/whatsapp-session.ts owns that path). `store/` is symlinked
 * into `$BASE/state/` by cloud-start.sh, so the session survives updates,
 * restarts and pauses. On the terminal block this relay then calls
 * `startChannelAdapter('whatsapp')`, so the trunk adapter goes live on the
 * scan itself — no restart, exactly like the telegram/discord pair endpoints.
 *
 * Dependencies: WhatsApp needs Baileys, which is a trunk OPTIONAL dependency
 * (package.json `optionalDependencies`) — 46 MB that only a paired WhatsApp
 * claw should pay for. Optional means it CAN be absent (an install that ran
 * with optional deps pruned), and the pairing step imports it, so
 * `missingPairingDeps()` probes the checkout BEFORE spawning: absent deps
 * become an actionable message instead of an ESM-loader stack trace from a
 * doomed child. Two reporting bugs once hid exactly that failure for a
 * release — the status-block name pattern (`\S+`, not `\w+`: the step-level
 * failure block is `WHATSAPP-AUTH`, with a hyphen) and the stderr tail
 * (rolling + summarized, not "last chunk, last 500 bytes").
 *
 * The PNG rendering (`pngBase64`) uses the optional `qrcode` package; without
 * it the raw QR payload is still served and the dashboard renders it
 * client-side.
 *
 * Test seams (no live WhatsApp / Baileys in the suite):
 *   ONCELLCLAW_WA_AUTH_CMD          overrides the spawned command
 *   ONCELLCLAW_WA_AUTH_DIR          overrides the session directory
 *   ONCELLCLAW_WA_QR_TIMEOUT_MS     session timeout (default 5 min)
 *   ONCELLCLAW_WA_QR_RETRY_HOLDOFF_MS  failure holdoff before a re-spawn
 */
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import { startChannelAdapter } from './channel-registry.js';
import { WHATSAPP_OPTIONAL_DEPS, isWhatsappPaired } from './whatsapp-session.js';

export type WhatsappQrStatus = 'starting' | 'qr_ready' | 'paired' | 'already_paired' | 'failed';

export interface WhatsappQrState {
  status: WhatsappQrStatus;
  /** Raw QR payload — exactly what WhatsApp's scanner expects. */
  qr: string | null;
  /** The current QR rendered as a base64 PNG when `qrcode` is installed. */
  pngBase64: string | null;
  error?: string;
  /** Monotonic change counter — bumps on every state mutation. */
  version: number;
}

/**
 * Same command the add-whatsapp browser helper spawns (and the same one
 * add-whatsapp/SKILL.md documents) — one canonical pairing path however the
 * QR is displayed. Exported so a test can pin the argv shape the cell
 * posture uses against those two canonical copies.
 */
export const DEFAULT_AUTH_CMD = 'pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr';
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60_000;
/** After a failure, hold off re-spawning so a polling dashboard can show
 *  the error instead of hot-looping a broken pairing step. */
const DEFAULT_RETRY_HOLDOFF_MS = 10_000;

/**
 * Status-block framing shared with setup/status.ts emitStatus(). `\S+`, not
 * `\w+`: `setup/index.ts` names its step-level failure block after
 * `stepName.toUpperCase()`, so a whatsapp-auth crash arrives as
 * `WHATSAPP-AUTH` — a hyphen `\w` never matches. Same pattern as
 * setup/lib/runner.ts's StatusStream.
 */
const STATUS_BLOCK_RE = /=== NANOCLAW SETUP: (\S+) ===\n([\s\S]*?)\n=== END ===/g;

/** Keep enough stderr to find the first real error line, not just a stack tail. */
const STDERR_TAIL_LIMIT = 4000;
/** Cap what reaches the dashboard's single-line error field. */
const ERROR_SUMMARY_LIMIT = 300;

function authCmd(): string {
  return process.env.ONCELLCLAW_WA_AUTH_CMD || DEFAULT_AUTH_CMD;
}

/** True when the relay is about to run the canonical step (not a test seam
 *  or operator override) — the only case whose dependencies we can know. */
function usingCanonicalStep(): boolean {
  return !process.env.ONCELLCLAW_WA_AUTH_CMD;
}

/** Is `dep` installed anywhere the spawned step could resolve it from? */
function isPackageInstalled(dep: string, from: string): boolean {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', dep, 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Which of WhatsApp's optional trunk dependencies are missing from this
 * checkout. Non-empty means spawning the pairing step can only produce an
 * ERR_MODULE_NOT_FOUND, so the relay reports that up front instead.
 *
 * Probed by path rather than `require.resolve` so the check stays a pure disk
 * read: it must not evaluate a package, and it must not mis-report an
 * ESM-only package as absent because the `require` condition failed.
 */
export function missingPairingDeps(): string[] {
  const root = process.cwd();
  try {
    return WHATSAPP_OPTIONAL_DEPS.filter((dep) => !isPackageInstalled(dep, root));
  } catch (err) {
    // An unreadable node_modules is not proof of absence — let the spawn
    // speak instead of blocking pairing on a probe failure.
    log.warn('WhatsApp pairing dependency probe failed — spawning anyway', { err });
    return [];
  }
}

/**
 * Reduce a child's stderr to the one line worth showing. Prefers the first
 * `SomeError: message` line (an ERR_MODULE_NOT_FOUND's own line, not the
 * loader frames below it), else the last non-empty line.
 */
export function summarizeStderr(tail: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = tail.replace(/\x1b\[[0-9;]*m/g, '');
  const errLine = /\b([A-Za-z]*Error(?: \[[^\]]+\])?: [^\n]+)/.exec(plain);
  const line = (
    errLine?.[1] ??
    plain
      .split('\n')
      .filter((l) => l.trim())
      .at(-1) ??
    ''
  ).trim();
  return line.length > ERROR_SUMMARY_LIMIT ? `${line.slice(0, ERROR_SUMMARY_LIMIT)}…` : line;
}

function envMs(key: string, fallback: number): number {
  const raw = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

interface Session {
  state: WhatsappQrState;
  child: ChildProcess | null;
  buffer: string;
  stderrTail: string;
  timeout: ReturnType<typeof setTimeout> | null;
  done: boolean;
  endedAt: number;
}

let session: Session | null = null;
const qrEvents = new EventEmitter();
qrEvents.setMaxListeners(0);

/** Subscribe to state changes (SSE push). Returns the unsubscribe. */
export function onWhatsappQrChange(listener: () => void): () => void {
  qrEvents.on('change', listener);
  return () => qrEvents.off('change', listener);
}

function bump(state: WhatsappQrState): void {
  state.version += 1;
  qrEvents.emit('change');
}

/**
 * Current pairing state, starting a pairing session when none is live:
 *  - creds already on disk (and no session running) → `already_paired`
 *  - live session → its current state (QR included once Baileys emits one)
 *  - finished session → its terminal state; a `failed` one is re-spawned
 *    after the holdoff, so "request the QR again" is the retry gesture
 */
export function ensureWhatsappPairing(): WhatsappQrState {
  if (session) {
    if (!session.done) return session.state;
    if (
      session.state.status === 'failed' &&
      Date.now() - session.endedAt >= envMs('ONCELLCLAW_WA_QR_RETRY_HOLDOFF_MS', DEFAULT_RETRY_HOLDOFF_MS)
    ) {
      session = null; // holdoff over — fall through to a fresh attempt
    } else {
      return session.state;
    }
  }
  if (isWhatsappPaired()) {
    return { status: 'already_paired', qr: null, pngBase64: null, version: 0 };
  }
  const missing = usingCanonicalStep() ? missingPairingDeps() : [];
  if (missing.length > 0) {
    session = deadSession(
      `WhatsApp pairing cannot run on this claw — ${missing.join(', ')} ` +
        `${missing.length > 1 ? 'are' : 'is'} absent from this checkout. WhatsApp ships in trunk, but Baileys ` +
        `is an optional dependency (package.json optionalDependencies) and this install does not have it. ` +
        `Re-run \`pnpm install\` without --no-optional, then request the QR again ` +
        `(or point ONCELLCLAW_WA_AUTH_CMD at your own pairing command).`,
    );
    return session.state;
  }
  session = startSession();
  return session.state;
}

/** Snapshot without starting anything (null when nothing ever ran). */
export function currentWhatsappQrState(): WhatsappQrState | null {
  return session?.state ?? null;
}

/** Tear the relay down (web channel teardown / tests). */
export function stopWhatsappPairing(): void {
  if (!session) return;
  const child = session.child;
  if (session.timeout) clearTimeout(session.timeout);
  session = null;
  try {
    child?.kill('SIGTERM');
  } catch {
    // already gone
  }
}

function blankSession(): Session {
  return {
    state: { status: 'starting', qr: null, pngBase64: null, version: 0 },
    child: null,
    buffer: '',
    stderrTail: '',
    timeout: null,
    done: false,
    endedAt: 0,
  };
}

/**
 * An already-terminal failed session — nothing was spawned. It still goes
 * through the normal holdoff/retry path, so a dashboard that keeps polling
 * shows the error, and a claw that later gains the missing pieces starts
 * pairing for real on the next request after the holdoff.
 */
function deadSession(error: string): Session {
  const dead = blankSession();
  dead.done = true;
  dead.endedAt = Date.now();
  dead.state.status = 'failed';
  dead.state.error = error;
  log.warn('WhatsApp QR pairing unavailable', { error });
  bump(dead.state);
  return dead;
}

function startSession(): Session {
  const fresh = blankSession();

  const cmd = authCmd();
  log.info('WhatsApp QR pairing session starting', { cmd });
  let child: ChildProcess;
  try {
    child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return deadSession(`could not start the pairing step: ${err instanceof Error ? err.message : String(err)}`);
  }
  fresh.child = child;

  fresh.timeout = setTimeout(
    () => {
      finish(fresh, 'failed', 'pairing session timed out — request the QR again to retry');
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    },
    envMs('ONCELLCLAW_WA_QR_TIMEOUT_MS', DEFAULT_SESSION_TIMEOUT_MS),
  );
  fresh.timeout.unref?.();

  child.stdout?.on('data', (chunk: Buffer) => {
    fresh.buffer += chunk.toString();
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    STATUS_BLOCK_RE.lastIndex = 0;
    while ((match = STATUS_BLOCK_RE.exec(fresh.buffer)) !== null) {
      handleBlock(fresh, match[1]!, parseBlockFields(match[2]!));
      lastEnd = match.index + match[0].length;
    }
    if (lastEnd > 0) fresh.buffer = fresh.buffer.slice(lastEnd);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    // A ROLLING bounded tail, not the last chunk: a dying step writes its
    // error line and its stack in one or many chunks, and keeping only the
    // last 500 bytes of the last chunk throws away the error and keeps the
    // loader frames — which is exactly how a missing `pino` once reached the
    // dashboard as a truncated "…esolveTsPaths (…/tsx/dist/register…)".
    fresh.stderrTail = (fresh.stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
  });
  child.on('error', (err) => {
    finish(fresh, 'failed', `pairing step failed to spawn: ${err.message}`);
  });
  child.on('exit', (code) => {
    if (fresh.done) return;
    const detail = summarizeStderr(fresh.stderrTail);
    finish(fresh, 'failed', `pairing step exited (code=${code ?? 'null'})${detail ? ` — ${detail}` : ''}`);
  });

  return fresh;
}

function parseBlockFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!] = kv[2]!;
  }
  return fields;
}

function handleBlock(target: Session, rawName: string, fields: Record<string, string>): void {
  if (target.done) return;
  // The step emits `WHATSAPP_AUTH*`; setup/index.ts's own catch-all names its
  // failure block `stepName.toUpperCase()` — `WHATSAPP-AUTH`. Same block,
  // different separator, so normalise rather than match two spellings.
  const name = rawName.replace(/-/g, '_');
  if (name === 'WHATSAPP_AUTH_QR' && fields.QR) {
    target.state.status = 'qr_ready';
    target.state.qr = fields.QR;
    target.state.pngBase64 = null;
    bump(target.state);
    void renderPng(target, fields.QR);
    return;
  }
  if (name === 'WHATSAPP_AUTH') {
    if (fields.STATUS === 'success') {
      finish(target, 'paired');
    } else if (fields.STATUS === 'skipped') {
      finish(target, 'already_paired');
    } else if (fields.STATUS === 'failed') {
      finish(target, 'failed', fields.ERROR ?? 'unknown error');
    }
  }
}

function finish(target: Session, status: 'paired' | 'already_paired' | 'failed', error?: string): void {
  if (target.done) return;
  target.done = true;
  target.endedAt = Date.now();
  if (target.timeout) clearTimeout(target.timeout);
  target.timeout = null;
  target.state.status = status;
  if (status !== 'failed') {
    target.state.qr = null;
    target.state.pngBase64 = null;
  }
  if (error) target.state.error = error;
  if (status === 'failed') log.warn('WhatsApp QR pairing failed', { error });
  else log.info('WhatsApp QR pairing finished', { status });
  bump(target.state);
  if (status === 'paired') void activatePairedChannel();
}

/**
 * Bring the trunk WhatsApp adapter up on the scan that just succeeded.
 *
 * Without this, a scan writes credentials the running process never looks at
 * again and the channel stays dark until the next restart — the dashboard
 * would report a successful pairing against a dead channel. This is the same
 * gesture the telegram/discord pair endpoints make after storing a token.
 *
 * Best-effort by design: the credentials are already on disk and durable, so
 * the worst case of a failure here is "live at next boot", never a lost pair.
 */
async function activatePairedChannel(): Promise<void> {
  try {
    const adapter = await startChannelAdapter('whatsapp');
    if (adapter) log.info('WhatsApp channel started after pairing');
    else log.warn('WhatsApp paired but the adapter declined to start — no session found on disk');
  } catch (err) {
    log.error('WhatsApp paired but the adapter failed to start — it will come up on the next restart', { err });
  }
}

/**
 * Render the raw QR as a base64 PNG via the optional `qrcode` package.
 * Best-effort: where optional deps were pruned, pngBase64 stays null and the
 * raw payload still serves — the dashboard can render it client-side.
 */
async function renderPng(target: Session, qr: string): Promise<void> {
  try {
    const mod = (await import('qrcode' as string)) as {
      toBuffer(text: string, opts?: { width?: number; margin?: number }): Promise<Buffer>;
    };
    const buffer = await mod.toBuffer(qr, { width: 360, margin: 1 });
    // The QR may have rotated while rendering — never attach a stale PNG.
    if (target.done || target.state.qr !== qr) return;
    target.state.pngBase64 = buffer.toString('base64');
    bump(target.state);
  } catch {
    log.info('qrcode not installed (optional dependency) — serving the raw QR payload only');
  }
}
