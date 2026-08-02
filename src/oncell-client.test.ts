import { describe, expect, it } from 'vitest';

import {
  createOnCellClient,
  isNoAppRunning,
  OnCellApiError,
  type FetchLike,
  type FetchResponseLike,
} from './oncell-client.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(status: number, payload: unknown): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

/** Fetch mock returning queued responses (last response repeats). */
function mockFetch(responses: FetchResponseLike[]): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve(next ?? jsonResponse(200, {}));
  };
  return { fetchImpl, calls };
}

describe('createOnCellClient', () => {
  it('throws without an API key', () => {
    expect(() => createOnCellClient({ apiKey: '' })).toThrow(/ONCELL_API_KEY/);
  });

  it('createCell posts snake_case body with bearer auth', async () => {
    const { fetchImpl, calls } = mockFetch([jsonResponse(200, { cell_id: 'dev--claw-main', status: 'running' })]);
    const client = createOnCellClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl });

    const cell = await client.createCell('claw-main');

    expect(cell.cell_id).toBe('dev--claw-main');
    expect(calls[0].url).toBe('https://api.test/api/v1/cells');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.authorization).toBe('Bearer k');
    expect(JSON.parse(calls[0].body!)).toEqual({ customer_id: 'claw-main' });
  });

  it('writeFile goes through the request door envelope', async () => {
    const { fetchImpl, calls } = mockFetch([jsonResponse(200, { ok: true })]);
    const client = createOnCellClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl });

    await client.writeFile('cell-1', 'claw/agent/CLAUDE.md', '# hi');

    expect(calls[0].url).toBe('https://api.test/api/v1/cells/cell-1/request');
    expect(JSON.parse(calls[0].body!)).toEqual({
      method: 'write_file',
      params: { path: 'claw/agent/CLAUDE.md', content: '# hi' },
    });
  });

  it('surfaces API errors with the code from the body', async () => {
    const { fetchImpl } = mockFetch([jsonResponse(404, { code: 'CELL_NOT_FOUND', message: 'no such cell' })]);
    const client = createOnCellClient({ apiKey: 'k', fetchImpl });

    await expect(client.getCell('nope')).rejects.toMatchObject({
      name: 'OnCellApiError',
      status: 404,
      code: 'CELL_NOT_FOUND',
    });
  });

  it('retries an idempotent request once on 502', async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse(502, { message: 'bad gateway' }),
      jsonResponse(200, { cell_id: 'c', status: 'running' }),
    ]);
    const client = createOnCellClient({ apiKey: 'k', fetchImpl, retryBackoffMs: 1 });

    const cell = await client.getCell('c');

    expect(cell.status).toBe('running');
    expect(calls.length).toBe(2);
  });

  it('never retries /service 503 (semantic NO_APP_RUNNING)', async () => {
    const { fetchImpl, calls } = mockFetch([jsonResponse(503, { code: 'NO_APP_RUNNING', message: 'nothing runs' })]);
    const client = createOnCellClient({ apiKey: 'k', fetchImpl, retryBackoffMs: 1 });

    let caught: unknown;
    try {
      await client.getService('c');
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(OnCellApiError);
    expect(isNoAppRunning(caught)).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('exec with expectSuccess throws on a non-zero exit code', async () => {
    const { fetchImpl } = mockFetch([
      jsonResponse(200, { exit_code: 1, stdout: '', stderr: 'boom', truncated: false, duration_ms: 5 }),
    ]);
    const client = createOnCellClient({ apiKey: 'k', fetchImpl });

    await expect(client.exec('c', { cmd: 'false', expectSuccess: true })).rejects.toThrow(/exit 1/);
  });
});
