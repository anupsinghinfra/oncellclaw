/**
 * Incremental host→cell workspace sync.
 *
 * The docker runtime bind-mounts the group folder, composed CLAUDE.md,
 * skills, and the agent-runner source into the container. A cell has no
 * mounts, so this module reproduces the same tree inside the cell workspace
 * via the request door (write_file), incrementally:
 *
 *   - every sync computes a content-hash manifest {cellPath → sha256}
 *   - the previous manifest lives in the cell KV (db_get/db_set), so only
 *     files whose hash changed are re-uploaded, and files that disappeared
 *     locally are deleted in the cell
 *   - text files go through write_file directly; binary files are uploaded
 *     as base64 side-files and decoded in the cell via exec
 *
 * Credentials never travel through this module: .env-style files are
 * excluded unconditionally (agent credentials flow only through service
 * env at start — see cell-runner.ts).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';
import type { OnCellClient } from './oncell-client.js';

export const SYNC_MANIFEST_KV_KEY = 'claw:sync-manifest:v1';

/** Directory names never synced into a cell. */
const EXCLUDED_DIRS = new Set(['node_modules', '.git']);

/** Chunk size for batched exec commands (decode/rm), well under the 8k cmd cap. */
const EXEC_BATCH_CHARS = 6000;

/** A sync source: one local directory (or file) mapped to a cell path prefix. */
export interface SyncSource {
  /** Local absolute path — file or directory. Missing paths are skipped. */
  localPath: string;
  /** Cell path (relative to the cell workspace root) the source maps to. */
  cellPath: string;
}

export interface SyncResult {
  written: number;
  deleted: number;
  unchanged: number;
}

/** Files whose basename must never be uploaded (credential material). */
export function isExcludedFile(basename: string): boolean {
  return basename === '.env' || basename.startsWith('.env.') || basename === '.heartbeat';
}

interface CollectedFile {
  localPath: string;
  cellPath: string;
  sha256: string;
}

function hashFile(localPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
}

/** Walk a source and return regular files (symlinks and excluded names skipped). */
export function collectSourceFiles(source: SyncSource): CollectedFile[] {
  const stat = fs.lstatSync(source.localPath, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) {
    if (isExcludedFile(path.basename(source.localPath))) return [];
    return [{ localPath: source.localPath, cellPath: source.cellPath, sha256: hashFile(source.localPath) }];
  }
  if (!stat.isDirectory()) return [];

  const collected: CollectedFile[] = [];
  const walk = (dir: string, cellDir: string): void => {
    for (const entry of fs.readdirSync(dir)) {
      const localPath = path.join(dir, entry);
      const entryStat = fs.lstatSync(localPath);
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry)) walk(localPath, `${cellDir}/${entry}`);
        continue;
      }
      if (!entryStat.isFile() || isExcludedFile(entry)) continue;
      collected.push({ localPath, cellPath: `${cellDir}/${entry}`, sha256: hashFile(localPath) });
    }
  };
  walk(source.localPath, source.cellPath);
  return collected;
}

/** UTF-8 round-trip check: safe for write_file as a plain string? */
export function isTextContent(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Batch shell fragments into commands that stay under the exec length cap. */
function batchCommands(fragments: string[]): string[] {
  const batches: string[] = [];
  let current = '';
  for (const fragment of fragments) {
    const next = current ? `${current} && ${fragment}` : fragment;
    if (next.length > EXEC_BATCH_CHARS && current) {
      batches.push(current);
      current = fragment;
    } else {
      current = next;
    }
  }
  if (current) batches.push(current);
  return batches;
}

async function uploadFile(client: OnCellClient, cellId: string, file: CollectedFile): Promise<string | null> {
  const buf = fs.readFileSync(file.localPath);
  if (isTextContent(buf)) {
    await client.writeFile(cellId, file.cellPath, buf.toString('utf8'));
    return null;
  }
  // Binary: upload base64 side-file, return the decode fragment for batching.
  const b64Path = `${file.cellPath}.__b64`;
  await client.writeFile(cellId, b64Path, buf.toString('base64'));
  const q = shellQuote(file.cellPath);
  return `base64 -d ${shellQuote(b64Path)} > ${q} && rm -f ${shellQuote(b64Path)}`;
}

function readPreviousManifest(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const manifest: Record<string, string> = {};
  for (const [key, sha] of Object.entries(value as Record<string, unknown>)) {
    if (typeof sha === 'string') manifest[key] = sha;
  }
  return manifest;
}

/**
 * Sync all sources into the cell. Incremental: only files whose content hash
 * differs from the manifest stored in the cell KV are uploaded; manifest
 * entries with no local counterpart are deleted in the cell.
 */
export async function syncToCell(client: OnCellClient, cellId: string, sources: SyncSource[]): Promise<SyncResult> {
  const files = sources.flatMap((source) => collectSourceFiles(source));
  const previous = readPreviousManifest((await client.kvGet(cellId, SYNC_MANIFEST_KV_KEY)).value);

  const manifest: Record<string, string> = {};
  const decodeFragments: string[] = [];
  let written = 0;
  let unchanged = 0;

  for (const file of files) {
    manifest[file.cellPath] = file.sha256;
    if (previous[file.cellPath] === file.sha256) {
      unchanged += 1;
      continue;
    }
    const decodeFragment = await uploadFile(client, cellId, file);
    if (decodeFragment) decodeFragments.push(decodeFragment);
    written += 1;
  }

  const stale = Object.keys(previous).filter((cellPath) => !(cellPath in manifest));
  const rmFragments = stale.map((cellPath) => `rm -f ${shellQuote(cellPath)}`);

  for (const cmd of batchCommands([...decodeFragments, ...rmFragments])) {
    await client.exec(cellId, { cmd, timeoutMs: 60_000, expectSuccess: true });
  }

  await client.kvSet(cellId, SYNC_MANIFEST_KV_KEY, manifest);

  const result: SyncResult = { written, deleted: stale.length, unchanged };
  if (written > 0 || stale.length > 0) {
    log.info('Cell workspace synced', { cellId, ...result });
  }
  return result;
}
