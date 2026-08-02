/**
 * Host↔cell session IPC — the door-based mapping of upstream's file IPC.
 *
 * Upstream NanoClaw's host↔agent transport is file-based: the session dir is
 * bind-mounted at /workspace, the host writes inbound.db (SQLite, DELETE
 * journal, open-write-close per op), the agent-runner writes outbound.db and
 * touches .heartbeat, and inbox/ / outbox/ carry attachments. There is no
 * stdio or socket protocol — the files ARE the protocol.
 *
 * The cell mapping keeps that protocol byte-for-byte and replaces the bind
 * mount with a bidirectional pump over the request door + exec:
 *
 *   host → cell : inbound.db + inbox files, pushed when they change locally
 *                 (base64 side-file + atomic mv, so the runner's per-poll
 *                 read-only open never sees a torn file)
 *   cell → host : outbound.db + .heartbeat mtime + outbox files, pulled by a
 *                 single status exec per tick that snapshots outbound.db only
 *                 when its hash changed AND no -journal file is present
 *                 (mirrors the DELETE-journal single-writer invariant)
 *
 * The host-side session dir stays the source of truth for the rest of the
 * host (delivery poll, host-sweep) — those read the same local files they
 * always did, so they are untouched by the port.
 *
 * Known relaxation vs docker: writeOutboundDirect() host-writes into
 * outbound.db; if it races a pump pull the host-inserted row can be
 * clobbered by the cell copy. Its only caller (command-gate denials)
 * runs when no agent is active, so the race window is theoretical.
 */
import fs from 'fs';
import path from 'path';

import type { ExecResult, OnCellClient } from './oncell-client.js';

/** Where a session lives inside the cell workspace (relative paths). */
export function cellSessionRoot(): string {
  return 'claw/session';
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Push one local file into the cell at cellPath. Base64 side-file + decode +
 * atomic mv: the runner opens inbound.db fresh on every poll, so a rename
 * swap is always a consistent view.
 */
export async function pushFileToCell(
  client: OnCellClient,
  cellId: string,
  localPath: string,
  cellPath: string,
): Promise<void> {
  const b64 = fs.readFileSync(localPath).toString('base64');
  const b64Path = `${cellPath}.__push`;
  await client.writeFile(cellId, b64Path, b64);
  const dir = path.posix.dirname(cellPath);
  await client.exec(cellId, {
    cmd:
      `mkdir -p ${shellQuote(dir)} && base64 -d ${shellQuote(b64Path)} > ${shellQuote(`${cellPath}.tmp`)} && ` +
      `mv ${shellQuote(`${cellPath}.tmp`)} ${shellQuote(cellPath)} && rm -f ${shellQuote(b64Path)}`,
    timeoutMs: 30_000,
    expectSuccess: true,
  });
}

/** Parsed result of the per-tick status exec. */
export interface CellSessionStatus {
  /** True when the session dir does not exist in the cell yet. */
  missing: boolean;
  /** Heartbeat mtime in epoch seconds; 0 when the file is absent. */
  heartbeatEpochSec: number;
  /** True when a fresh outbound snapshot was staged for pulling. */
  outboundStaged: boolean;
  /** Outbox file paths (relative to the session root) present in the cell. */
  outboxFiles: string[];
}

/**
 * One exec per tick: read heartbeat mtime, stage a consistent outbound.db
 * snapshot (skip while a -journal file exists — a write is mid-flight), and
 * list outbox files. Everything else is derived from this single round-trip.
 */
export function buildStatusCmd(sessionRoot: string): string {
  const root = shellQuote(sessionRoot);
  return [
    `cd ${root} 2>/dev/null || { echo MISSING; exit 0; }`,
    `echo "HB $(stat -c %Y .heartbeat 2>/dev/null || echo 0)"`,
    `STAGED=0`,
    `if [ -f outbound.db ] && [ ! -f outbound.db-journal ]; then`,
    `  SHA=$( (sha256sum outbound.db 2>/dev/null || shasum -a 256 outbound.db) | cut -d" " -f1 )`,
    `  if [ "$SHA" != "$(cat .outbound.last 2>/dev/null)" ]; then`,
    `    cp outbound.db .outbound.pull && base64 .outbound.pull > .outbound.pull.b64 && echo "$SHA" > .outbound.last && STAGED=1`,
    `  fi`,
    `fi`,
    `echo "STAGED $STAGED"`,
    `find outbox -maxdepth 2 -type f 2>/dev/null | while read -r f; do echo "OUTBOX $f"; done`,
  ].join('\n');
}

export function parseStatusOutput(stdout: string): CellSessionStatus {
  const status: CellSessionStatus = { missing: false, heartbeatEpochSec: 0, outboundStaged: false, outboxFiles: [] };
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'MISSING') return { ...status, missing: true };
    if (trimmed.startsWith('HB ')) {
      const parsed = Number(trimmed.slice(3));
      if (Number.isFinite(parsed)) status.heartbeatEpochSec = parsed;
    } else if (trimmed.startsWith('STAGED ')) {
      status.outboundStaged = trimmed.slice(7) === '1';
    } else if (trimmed.startsWith('OUTBOX ')) {
      status.outboxFiles.push(trimmed.slice(7));
    }
  }
  return status;
}

export async function fetchSessionStatus(
  client: OnCellClient,
  cellId: string,
  sessionRoot: string,
): Promise<CellSessionStatus> {
  const result: ExecResult = await client.exec(cellId, { cmd: buildStatusCmd(sessionRoot), timeoutMs: 30_000 });
  if (result.exit_code !== 0) {
    throw new Error(`cell status exec failed (exit ${result.exit_code}): ${result.stderr.slice(0, 300)}`);
  }
  return parseStatusOutput(result.stdout);
}

/**
 * Pull the staged outbound.db snapshot and atomically replace the local copy.
 * The host delivery poll opens outbound.db read-only per poll, so a rename
 * swap is always a consistent view on the host side too.
 */
export async function pullOutboundDb(
  client: OnCellClient,
  cellId: string,
  sessionRoot: string,
  localOutboundPath: string,
): Promise<void> {
  const { content } = await client.readFile(cellId, `${sessionRoot}/.outbound.pull.b64`);
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('empty outbound snapshot from cell');
  }
  const buf = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  const tmpPath = `${localOutboundPath}.cellpull`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, localOutboundPath);
}

/** Pull one outbox file from the cell into the local session dir. */
export async function pullOutboxFile(
  client: OnCellClient,
  cellId: string,
  sessionRoot: string,
  relPath: string,
  localSessionDir: string,
): Promise<void> {
  const cellPath = `${sessionRoot}/${relPath}`;
  const b64Path = `${cellPath}.__pull`;
  await client.exec(cellId, {
    cmd: `base64 ${shellQuote(cellPath)} > ${shellQuote(b64Path)}`,
    timeoutMs: 30_000,
    expectSuccess: true,
  });
  const { content } = await client.readFile(cellId, b64Path);
  await client.exec(cellId, { cmd: `rm -f ${shellQuote(b64Path)}`, timeoutMs: 15_000 });
  if (typeof content !== 'string') throw new Error(`empty outbox pull for ${relPath}`);
  const localPath = path.join(localSessionDir, relPath);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, Buffer.from(content.replace(/\s+/g, ''), 'base64'));
}

/**
 * Mirror the cell's heartbeat mtime onto the local heartbeat file so
 * host-sweep's liveness rules (ceiling + claim-stuck) work unchanged.
 */
export function applyHeartbeat(localHeartbeatPath: string, epochSec: number): void {
  if (epochSec <= 0) return;
  const when = new Date(epochSec * 1000);
  try {
    fs.utimesSync(localHeartbeatPath, when, when);
  } catch {
    fs.writeFileSync(localHeartbeatPath, '');
    fs.utimesSync(localHeartbeatPath, when, when);
  }
}
