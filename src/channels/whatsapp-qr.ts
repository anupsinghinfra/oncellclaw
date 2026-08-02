/**
 * WhatsApp QR pairing relay — hosted claws pair by scanning the Baileys QR
 * in the dashboard instead of a terminal.
 *
 * Self-host already pairs via the add-whatsapp skill: the trunk-maintained
 * setup step (`setup/whatsapp-auth.ts`) runs Baileys and emits each rotating
 * QR as a structured status block on stdout (`WHATSAPP_AUTH_QR { QR }`,
 * terminal `WHATSAPP_AUTH { STATUS }` — see that file's header). This module
 * reuses that step as THE pairing source: it spawns the same command the
 * `.claude/skills/add-whatsapp` browser helper spawns, parses the same
 * blocks, and holds the current QR for `GET /web/channels/whatsapp/qr`
 * (src/channels/web.ts) to serve — JSON snapshot or SSE stream — until the
 * phone scans it.
 *
 * Session persistence: on success Baileys writes `store/auth/` (the setup
 * step owns that write). On a hosted cell `store/` lives under the durable
 * `state/` directory that cloud-start symlinks into every checkout, so the
 * linked session survives updates and restarts — nothing extra to do here.
 *
 * Trunk boundaries, stated plainly:
 *  - Baileys and `qrcode` are add-whatsapp-installed dependencies, not
 *    trunk's. When they are absent the spawned step fails and this relay
 *    reports `failed` with the child's error — it never fakes a QR.
 *  - The PNG rendering (`pngBase64`) needs the skill-installed `qrcode`
 *    package; without it the raw QR payload is still served and the
 *    dashboard can render it client-side.
 *
 * Test seams (no live WhatsApp / Baileys in the suite):
 *   ONCELLCLAW_WA_AUTH_CMD          overrides the spawned command
 *   ONCELLCLAW_WA_AUTH_DIR          overrides the creds directory probe
 *   ONCELLCLAW_WA_QR_TIMEOUT_MS     session timeout (default 5 min)
 *   ONCELLCLAW_WA_QR_RETRY_HOLDOFF_MS  failure holdoff before a re-spawn
 */
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

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

/** Same command the add-whatsapp browser helper spawns — one canonical
 *  pairing path however the QR is displayed. */
const DEFAULT_AUTH_CMD = 'pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr';
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60_000;
/** After a failure, hold off re-spawning so a polling dashboard can show
 *  the error instead of hot-looping a broken pairing step. */
const DEFAULT_RETRY_HOLDOFF_MS = 10_000;

/** Status-block framing shared with setup/status.ts emitStatus(). */
const STATUS_BLOCK_RE = /=== NANOCLAW SETUP: (\w+) ===\n([\s\S]*?)\n=== END ===/g;

function authCmd(): string {
  return process.env.ONCELLCLAW_WA_AUTH_CMD || DEFAULT_AUTH_CMD;
}

function authDir(): string {
  return process.env.ONCELLCLAW_WA_AUTH_DIR || path.join(process.cwd(), 'store', 'auth');
}

function envMs(key: string, fallback: number): number {
  const raw = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

/** Linked-device credentials on disk = this install is already paired. */
export function isWhatsappPaired(): boolean {
  try {
    return fs.existsSync(path.join(authDir(), 'creds.json'));
  } catch {
    return false;
  }
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

function startSession(): Session {
  const fresh: Session = {
    state: { status: 'starting', qr: null, pngBase64: null, version: 0 },
    child: null,
    buffer: '',
    stderrTail: '',
    timeout: null,
    done: false,
    endedAt: 0,
  };

  const cmd = authCmd();
  log.info('WhatsApp QR pairing session starting', { cmd });
  let child: ChildProcess;
  try {
    child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    fresh.done = true;
    fresh.endedAt = Date.now();
    fresh.state.status = 'failed';
    fresh.state.error = `could not start the pairing step: ${err instanceof Error ? err.message : String(err)}`;
    bump(fresh.state);
    return fresh;
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
    // Keep the last chunk — when the step dies (e.g. Baileys not installed
    // on this checkout) this is the only useful diagnosis.
    fresh.stderrTail = chunk.toString().slice(-500);
  });
  child.on('error', (err) => {
    finish(fresh, 'failed', `pairing step failed to spawn: ${err.message}`);
  });
  child.on('exit', (code) => {
    if (fresh.done) return;
    const detail = fresh.stderrTail.trim();
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

function handleBlock(target: Session, name: string, fields: Record<string, string>): void {
  if (target.done) return;
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
}

/**
 * Render the raw QR as a base64 PNG via the skill-installed `qrcode`
 * package. Best-effort: on installs where add-whatsapp hasn't run (no
 * `qrcode`), pngBase64 stays null and the raw payload still serves.
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
    log.info('qrcode package not installed — serving the raw QR payload only');
  }
}
