/**
 * Minimal OnCell API client for oncellclaw.
 *
 * Self-contained fetch wrapper — no workspace deps — mirroring the request
 * shapes of the proven typed client this fork's cell runtime was designed
 * against, trimmed to exactly what cell-runner/cell-sync need: cells, exec,
 * the request door (files + KV), and the service supervisor.
 *
 * Conventions:
 *   - inputs are camelCase and mapped to snake_case on the wire
 *   - responses are kept in wire form (snake_case) with an index signature
 *   - retry policy: exactly one retry, only on 502/503 (transient host
 *     resume path), and only for idempotent requests. The /service endpoints
 *     use 503 semantically (NO_APP_RUNNING) so they are never retried.
 */

export const DEFAULT_ONCELL_API_URL = 'https://api.oncell.ai';
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503]);
const DEFAULT_RETRY_BACKOFF_MS = 250;

/** A cell record as returned by the API. cell_id = {developerId}--{customer_id}. */
export interface CellRecord {
  readonly cell_id: string;
  readonly status: string;
  readonly customer_id?: string;
  readonly preview_url?: string | null;
  readonly [key: string]: unknown;
}

/** Result of an exec call, in wire form. */
export interface ExecResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly duration_ms: number;
  readonly [key: string]: unknown;
}

/** A service record as returned by the /service endpoints. */
export interface ServiceRecord {
  readonly running: boolean;
  readonly port?: number;
  readonly cmd?: string;
  readonly [key: string]: unknown;
}

/** Expected shape of a read_file door result. */
export interface ReadFileResult {
  readonly content?: string;
  readonly [key: string]: unknown;
}

/** Expected shape of a db_get door result. */
export interface KvGetResult {
  readonly value?: unknown;
  readonly [key: string]: unknown;
}

/** Methods accepted by POST /api/v1/cells/{id}/request. */
export type CellRequestMethod =
  'write_file' | 'read_file' | 'list_files' | 'db_get' | 'db_set' | 'journal' | 'logs' | 'metrics';

export interface ExecInput {
  readonly cmd: string;
  readonly timeoutMs?: number;
  /** When true, throws OnCellApiError on a non-zero exit code. */
  readonly expectSuccess?: boolean;
}

/** Structural view of fetch so tests can inject a mock. */
export interface FetchResponseLike {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export class OnCellApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(args: { status: number; code: string; message: string }) {
    super(args.message);
    this.name = 'OnCellApiError';
    this.status = args.status;
    this.code = args.code;
  }
}

/** True for GET/DELETE /service 503s — "no app running", not a failure. */
export function isNoAppRunning(err: unknown): boolean {
  return err instanceof OnCellApiError && err.status === 503;
}

export interface OnCellClientOptions {
  readonly apiKey: string;
  /** Defaults to https://api.oncell.ai. */
  readonly baseUrl?: string;
  /** Injectable fetch (tests); defaults to the global fetch. */
  readonly fetchImpl?: FetchLike;
  readonly retryBackoffMs?: number;
}

/** The subset of the OnCell API the cell runtime uses. */
export interface OnCellClient {
  createCell(customerId: string): Promise<CellRecord>;
  getCell(cellId: string): Promise<CellRecord>;
  listCells(): Promise<readonly CellRecord[]>;
  resumeCell(cellId: string): Promise<CellRecord>;
  exec(cellId: string, input: ExecInput): Promise<ExecResult>;
  request<T = unknown>(cellId: string, method: CellRequestMethod, params?: Record<string, unknown>): Promise<T>;
  writeFile(cellId: string, path: string, content: string): Promise<unknown>;
  readFile(cellId: string, path: string): Promise<ReadFileResult>;
  kvGet(cellId: string, key: string): Promise<KvGetResult>;
  kvSet(cellId: string, key: string, value: unknown): Promise<unknown>;
  startService(cellId: string, cmd: string, env?: Record<string, string>): Promise<ServiceRecord>;
  getService(cellId: string): Promise<ServiceRecord>;
  stopService(cellId: string): Promise<void>;
}

interface RequestSpec {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly idempotent: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseErrorBody(status: number, text: string): OnCellApiError {
  let code = 'API_ERROR';
  let message = text || `OnCell API error (status ${status})`;
  try {
    const parsed = JSON.parse(text) as { code?: string; error?: string; message?: string };
    if (typeof parsed.code === 'string') code = parsed.code;
    const msg = parsed.message ?? parsed.error;
    if (typeof msg === 'string' && msg) message = msg;
  } catch {
    /* non-JSON error body — keep raw text */
  }
  return new OnCellApiError({ status, code, message });
}

/** Creates the minimal typed OnCell client. Throws when apiKey is empty. */
export function createOnCellClient(options: OnCellClientOptions): OnCellClient {
  if (!options.apiKey) {
    throw new Error('OnCell API key missing: set ONCELL_API_KEY');
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_ONCELL_API_URL).replace(/\/$/, '');
  const fetchImpl: FetchLike = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const backoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

  async function attempt(spec: RequestSpec): Promise<FetchResponseLike> {
    try {
      return await fetchImpl(`${baseUrl}${spec.path}`, {
        method: spec.method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(spec.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'network request failed';
      throw new OnCellApiError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: `${spec.method} ${spec.path}: ${message}`,
      });
    }
  }

  async function toData<T>(response: FetchResponseLike): Promise<T> {
    const text = await response.text();
    if (!response.ok) throw parseErrorBody(response.status, text);
    return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
  }

  async function send<T>(spec: RequestSpec): Promise<T> {
    const first = await attempt(spec);
    if (!RETRYABLE_STATUSES.has(first.status) || !spec.idempotent) {
      return toData<T>(first);
    }
    await sleep(backoffMs);
    return toData<T>(await attempt(spec));
  }

  function cellPath(cellId: string, suffix = ''): string {
    return `/api/v1/cells/${encodeURIComponent(cellId)}${suffix}`;
  }

  async function request<T = unknown>(
    cellId: string,
    method: CellRequestMethod,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return send<T>({ method: 'POST', path: cellPath(cellId, '/request'), body: { method, params }, idempotent: true });
  }

  return {
    // Idempotent-by-identity: re-create returns the existing cell record.
    createCell: (customerId) =>
      send<CellRecord>({ method: 'POST', path: '/api/v1/cells', body: { customer_id: customerId }, idempotent: true }),
    getCell: (cellId) => send<CellRecord>({ method: 'GET', path: cellPath(cellId), idempotent: true }),
    listCells: async () => {
      const data = await send<unknown>({ method: 'GET', path: '/api/v1/cells', idempotent: true });
      if (Array.isArray(data)) return data as CellRecord[];
      const nested = (data as { cells?: unknown })?.cells;
      if (Array.isArray(nested)) return nested as CellRecord[];
      throw new OnCellApiError({ status: 200, code: 'UNEXPECTED_RESPONSE', message: 'expected a cells array' });
    },
    resumeCell: (cellId) => send<CellRecord>({ method: 'POST', path: cellPath(cellId, '/resume'), idempotent: true }),
    exec: async (cellId, input) => {
      const result = await send<ExecResult>({
        method: 'POST',
        path: cellPath(cellId, '/exec'),
        body: { cmd: input.cmd, ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}) },
        idempotent: false,
      });
      if (input.expectSuccess === true && result.exit_code !== 0) {
        throw new OnCellApiError({
          status: 0,
          code: 'EXEC_FAILED',
          message: `exec failed (exit ${result.exit_code}): ${result.stderr.slice(0, 500)}`,
        });
      }
      return result;
    },
    request,
    writeFile: (cellId, path, content) => request(cellId, 'write_file', { path, content }),
    readFile: (cellId, path) => request<ReadFileResult>(cellId, 'read_file', { path }),
    kvGet: (cellId, key) => request<KvGetResult>(cellId, 'db_get', { key }),
    kvSet: (cellId, key, value) => request(cellId, 'db_set', { key, value }),
    // /service endpoints: 503 is semantic (NO_APP_RUNNING) — never retried.
    startService: (cellId, cmd, env) =>
      send<ServiceRecord>({
        method: 'POST',
        path: cellPath(cellId, '/service'),
        body: { cmd, ...(env !== undefined ? { env } : {}) },
        idempotent: false,
      }),
    getService: (cellId) =>
      send<ServiceRecord>({ method: 'GET', path: cellPath(cellId, '/service'), idempotent: false }),
    stopService: async (cellId) => {
      await send<unknown>({ method: 'DELETE', path: cellPath(cellId, '/service'), idempotent: false });
    },
  };
}
