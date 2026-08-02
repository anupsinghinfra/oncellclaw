import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isExcludedFile, isTextContent, SYNC_MANIFEST_KV_KEY, syncToCell } from './cell-sync.js';
import type { OnCellClient } from './oncell-client.js';

interface FakeCell {
  client: OnCellClient;
  writes: Array<{ path: string; content: string }>;
  execs: string[];
  kv: Map<string, unknown>;
}

function fakeCellClient(): FakeCell {
  const writes: Array<{ path: string; content: string }> = [];
  const execs: string[] = [];
  const kv = new Map<string, unknown>();
  const client = {
    writeFile: (_cell: string, p: string, content: string) => {
      writes.push({ path: p, content });
      return Promise.resolve({});
    },
    exec: (_cell: string, input: { cmd: string }) => {
      execs.push(input.cmd);
      return Promise.resolve({ exit_code: 0, stdout: '', stderr: '', truncated: false, duration_ms: 1 });
    },
    kvGet: (_cell: string, key: string) => Promise.resolve({ value: kv.get(key) }),
    kvSet: (_cell: string, key: string, value: unknown) => {
      kv.set(key, value);
      return Promise.resolve({});
    },
  } as unknown as OnCellClient;
  return { client, writes, execs, kv };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-sync-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('syncToCell', () => {
  it('uploads everything on first sync and stores the content-hash manifest', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# group');
    fs.mkdirSync(path.join(tmpDir, 'memory'));
    fs.writeFileSync(path.join(tmpDir, 'memory', 'index.md'), 'notes');
    const fake = fakeCellClient();

    const result = await syncToCell(fake.client, 'cell-1', [{ localPath: tmpDir, cellPath: 'claw/agent' }]);

    expect(result).toEqual({ written: 2, deleted: 0, unchanged: 0 });
    expect(fake.writes.map((w) => w.path).sort()).toEqual(['claw/agent/CLAUDE.md', 'claw/agent/memory/index.md']);
    const manifest = fake.kv.get(SYNC_MANIFEST_KV_KEY) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(['claw/agent/CLAUDE.md', 'claw/agent/memory/index.md']);
  });

  it('is incremental: an unchanged tree re-uploads nothing, a changed file re-uploads only itself', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'aaa');
    fs.writeFileSync(path.join(tmpDir, 'b.md'), 'bbb');
    const fake = fakeCellClient();
    const sources = [{ localPath: tmpDir, cellPath: 'claw/agent' }];

    await syncToCell(fake.client, 'cell-1', sources);
    fake.writes.length = 0;

    const unchanged = await syncToCell(fake.client, 'cell-1', sources);
    expect(unchanged).toEqual({ written: 0, deleted: 0, unchanged: 2 });
    expect(fake.writes.length).toBe(0);

    fs.writeFileSync(path.join(tmpDir, 'b.md'), 'BBB v2');
    const changed = await syncToCell(fake.client, 'cell-1', sources);
    expect(changed.written).toBe(1);
    expect(fake.writes.map((w) => w.path)).toEqual(['claw/agent/b.md']);
  });

  it('deletes cell files whose local counterpart disappeared', async () => {
    fs.writeFileSync(path.join(tmpDir, 'keep.md'), 'k');
    fs.writeFileSync(path.join(tmpDir, 'gone.md'), 'g');
    const fake = fakeCellClient();
    const sources = [{ localPath: tmpDir, cellPath: 'claw/agent' }];

    await syncToCell(fake.client, 'cell-1', sources);
    fs.rmSync(path.join(tmpDir, 'gone.md'));

    const result = await syncToCell(fake.client, 'cell-1', sources);
    expect(result.deleted).toBe(1);
    expect(fake.execs.some((cmd) => cmd.includes(`rm -f 'claw/agent/gone.md'`))).toBe(true);
    const manifest = fake.kv.get(SYNC_MANIFEST_KV_KEY) as Record<string, string>;
    expect(manifest['claw/agent/gone.md']).toBeUndefined();
  });

  it('never uploads .env-style credential files', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-secret');
    fs.writeFileSync(path.join(tmpDir, '.env.local'), 'X=1');
    fs.writeFileSync(path.join(tmpDir, 'ok.md'), 'fine');
    const fake = fakeCellClient();

    await syncToCell(fake.client, 'cell-1', [{ localPath: tmpDir, cellPath: 'claw/agent' }]);

    expect(fake.writes.map((w) => w.path)).toEqual(['claw/agent/ok.md']);
    expect(fake.writes.every((w) => !w.content.includes('sk-ant-secret'))).toBe(true);
  });

  it('uploads binary files as base64 side-files with a decode exec', async () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x42]);
    fs.writeFileSync(path.join(tmpDir, 'blob.db'), binary);
    const fake = fakeCellClient();

    await syncToCell(fake.client, 'cell-1', [{ localPath: tmpDir, cellPath: 'claw/agent' }]);

    expect(fake.writes[0].path).toBe('claw/agent/blob.db.__b64');
    expect(Buffer.from(fake.writes[0].content, 'base64').equals(binary)).toBe(true);
    expect(fake.execs.some((cmd) => cmd.includes(`base64 -d 'claw/agent/blob.db.__b64' > 'claw/agent/blob.db'`))).toBe(
      true,
    );
  });
});

describe('helpers', () => {
  it('isExcludedFile matches credential-style names only', () => {
    expect(isExcludedFile('.env')).toBe(true);
    expect(isExcludedFile('.env.production')).toBe(true);
    expect(isExcludedFile('.heartbeat')).toBe(true);
    expect(isExcludedFile('env.md')).toBe(false);
    expect(isExcludedFile('.envelope')).toBe(false);
  });

  it('isTextContent distinguishes utf-8 from binary', () => {
    expect(isTextContent(Buffer.from('hello 🚀', 'utf8'))).toBe(true);
    expect(isTextContent(Buffer.from([0x00, 0x01]))).toBe(false);
  });
});
