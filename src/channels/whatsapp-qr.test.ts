/**
 * WhatsApp QR pairing relay — the cell-posture regressions.
 *
 * The live bug these pin down: on a hosted claw the relay spawned
 * `pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr`, that
 * step statically imports `pino` and `@whiskeysockets/baileys` (the
 * add-whatsapp channel install's dependencies, never trunk's), and a hosted
 * checkout is a pristine trunk tarball — so the child died with
 * ERR_MODULE_NOT_FOUND inside the ESM loader before Baileys ever ran. Two
 * reporting bugs then hid the cause: the relay's status-block name pattern
 * could not match the hyphenated `WHATSAPP-AUTH` failure block that carried
 * the reason, and its stderr "tail" kept the last 500 bytes of the last chunk
 * — the loader frames — instead of the error line above them.
 *
 * Everything here is offline: no Baileys, no WhatsApp, no real pairing step.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_AUTH_CMD,
  ensureWhatsappPairing,
  missingPairingDeps,
  stopWhatsappPairing,
  summarizeStderr,
} from './whatsapp-qr.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-qr-'));
});

afterEach(() => {
  stopWhatsappPairing();
  vi.restoreAllMocks();
  delete process.env.ONCELLCLAW_WA_AUTH_CMD;
  delete process.env.ONCELLCLAW_WA_AUTH_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Fake an installed package the way pnpm lays one out under a checkout. */
function installFake(root: string, dep: string): void {
  const dir = path.join(root, 'node_modules', dep);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: dep, version: '0.0.0' }));
}

describe('whatsapp-qr — the command the cell posture spawns', () => {
  /**
   * One canonical pairing path. If this string drifts from the step the
   * add-whatsapp skill documents, hosted pairing and terminal pairing stop
   * being the same operation — which is the whole premise of the relay.
   */
  it('is the canonical whatsapp-auth step, argv for argv', () => {
    expect(DEFAULT_AUTH_CMD.split(/\s+/)).toEqual([
      'pnpm',
      'exec',
      'tsx',
      'setup/index.ts',
      '--step',
      'whatsapp-auth',
      '--',
      '--method',
      'qr',
    ]);
  });

  it('matches the command add-whatsapp/SKILL.md tells operators to run', () => {
    const skill = fs.readFileSync(path.join(REPO_ROOT, '.claude/skills/add-whatsapp/SKILL.md'), 'utf-8');
    expect(skill).toContain(DEFAULT_AUTH_CMD);
  });

  it('matches the argv the add-whatsapp browser helper spawns', () => {
    const helper = fs.readFileSync(
      path.join(REPO_ROOT, '.claude/skills/add-whatsapp/scripts/wa-qr-browser.ts'),
      'utf-8',
    );
    // The helper spawns 'pnpm' with an argv array — reconstruct and compare.
    const argv = /\[\s*'exec',[\s\S]*?\]/.exec(helper)?.[0] ?? '';
    const tokens = [...argv.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    expect(tokens.length).toBeGreaterThan(0);
    expect(['pnpm', ...tokens].join(' ')).toBe(DEFAULT_AUTH_CMD);
  });

  it('names a step setup/index.ts actually registers', () => {
    const index = fs.readFileSync(path.join(REPO_ROOT, 'setup/index.ts'), 'utf-8');
    expect(index).toContain("'whatsapp-auth': () => import('./whatsapp-auth.js')");
  });
});

describe('whatsapp-qr — skill-installed dependency preflight', () => {
  /**
   * `setup/whatsapp-auth.ts` imports these at module scope. Missing either
   * one means the spawn can only produce ERR_MODULE_NOT_FOUND.
   */
  it('reports every pairing dependency absent from the checkout', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    expect(missingPairingDeps()).toEqual(['pino', '@whiskeysockets/baileys']);
  });

  it('reports nothing missing once the channel install has run', () => {
    installFake(tmp, 'pino');
    installFake(tmp, '@whiskeysockets/baileys');
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    expect(missingPairingDeps()).toEqual([]);
  });

  it('reports only the dependency that is actually absent', () => {
    installFake(tmp, 'pino');
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    expect(missingPairingDeps()).toEqual(['@whiskeysockets/baileys']);
  });

  it('finds a dependency hoisted to an ancestor of the checkout', () => {
    const nested = path.join(tmp, 'src-abc123');
    fs.mkdirSync(nested, { recursive: true });
    installFake(tmp, 'pino');
    installFake(tmp, '@whiskeysockets/baileys');
    vi.spyOn(process, 'cwd').mockReturnValue(nested);
    expect(missingPairingDeps()).toEqual([]);
  });

  /**
   * The hosted failure, end to end: nothing is spawned, and the dashboard
   * gets a sentence an operator can act on instead of a tsx loader stack.
   */
  it('fails up front with an actionable error instead of spawning a doomed step', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    process.env.ONCELLCLAW_WA_AUTH_DIR = path.join(tmp, 'store', 'auth');

    const state = ensureWhatsappPairing();

    // Synchronously terminal — a real spawn would have left it 'starting'.
    expect(state.status).toBe('failed');
    expect(state.qr).toBeNull();
    expect(state.error).toContain('pino');
    expect(state.error).toContain('@whiskeysockets/baileys');
    expect(state.error).toContain('add-whatsapp');
    // Never the raw loader noise the live claw showed.
    expect(state.error).not.toContain('tsx');
  });

  it('does not preflight when the command is overridden — those deps are unknowable', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    process.env.ONCELLCLAW_WA_AUTH_DIR = path.join(tmp, 'store', 'auth');
    process.env.ONCELLCLAW_WA_AUTH_CMD = 'node -e "setTimeout(()=>{},60000)"';

    expect(ensureWhatsappPairing().status).toBe('starting');
  });
});

describe('whatsapp-qr — stderr summarization', () => {
  /**
   * Verbatim shape of what the live claw's pairing step wrote: one log line
   * carrying the message, then the ESM loader stack. Keeping the last 500
   * bytes of this is how the dashboard ended up showing "…esolveTsPaths".
   */
  const LIVE_STDERR = [
    `[19:28:18.905] ERROR Setup step failed err={ type: "Error", message: "Cannot find package 'pino' imported from /workspace/oncellclaw/src-0d82c1f/setup/whatsapp-auth.ts", stack: Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pino' imported from /workspace/oncellclaw/src-0d82c1f/setup/whatsapp-auth.ts`,
    '    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:314:9)',
    '    at packageResolve (node:internal/modules/esm/resolve:768:81)',
    '    at resolveTsPaths (file:///workspace/oncellclaw/src-0d82c1f/node_modules/.pnpm/tsx@4.23.4/node_modules/tsx/dist/register-zZ7SWseA.mjs:2:11114)',
    '    at resolve (file:///workspace/oncellclaw/src-0d82c1f/node_modules/.pnpm/tsx@4.23.4/node_modules/tsx/dist/register-zZ7SWseA.mjs:2:12294)',
    '    at Hooks.resolve (node:internal/modules/esm/hooks:240:30) } step="whatsapp-auth"',
  ].join('\n');

  it('surfaces the error line, not the loader frames underneath it', () => {
    const summary = summarizeStderr(LIVE_STDERR);
    expect(summary).toContain('ERR_MODULE_NOT_FOUND');
    expect(summary).toContain("Cannot find package 'pino'");
    expect(summary).not.toContain('resolveTsPaths');
    expect(summary).not.toContain('Hooks.resolve');
  });

  it('strips ANSI so a coloured log line stays readable', () => {
    expect(summarizeStderr('\x1b[31mERROR\x1b[39m TypeError: bad thing\n')).toBe('TypeError: bad thing');
  });

  it('falls back to the last non-empty line when nothing looks like an error', () => {
    expect(summarizeStderr('warming up\nstill going\n\n')).toBe('still going');
  });

  it('caps a runaway line rather than shipping a whole stack to the dashboard', () => {
    const summary = summarizeStderr(`Error: ${'x'.repeat(5000)}`);
    expect(summary.length).toBeLessThanOrEqual(301);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('is empty for a clean stderr, so the exit message stays bare', () => {
    expect(summarizeStderr('')).toBe('');
  });
});

describe('whatsapp-qr — step-level failure blocks', () => {
  /**
   * When the step itself throws, `setup/index.ts` catches and emits a block
   * named after `stepName.toUpperCase()` — `WHATSAPP-AUTH`, with a HYPHEN.
   * The relay used to match `(\w+)` and drop it, losing the one field that
   * said what went wrong.
   */
  it('parses the hyphenated WHATSAPP-AUTH block setup/index.ts emits on a crash', async () => {
    const stub = path.join(tmp, 'stub.cjs');
    fs.writeFileSync(
      stub,
      [
        "console.log('=== NANOCLAW SETUP: WHATSAPP-AUTH ===');",
        "console.log('STATUS: failed');",
        `console.log("ERROR: Cannot find package 'pino' imported from /workspace/setup/whatsapp-auth.ts");`,
        "console.log('=== END ===');",
        'process.exit(1);',
      ].join('\n'),
    );
    process.env.ONCELLCLAW_WA_AUTH_CMD = `node ${stub}`;
    process.env.ONCELLCLAW_WA_AUTH_DIR = path.join(tmp, 'store', 'auth');

    ensureWhatsappPairing();
    await vi.waitFor(
      () => {
        const state = ensureWhatsappPairing();
        expect(state.status).toBe('failed');
        // The block's own ERROR — not "pairing step exited (code=1)".
        expect(state.error).toContain("Cannot find package 'pino'");
      },
      { timeout: 5000 },
    );
  });

  it('still handles the underscored WHATSAPP_AUTH terminal block', async () => {
    const stub = path.join(tmp, 'stub.cjs');
    fs.writeFileSync(
      stub,
      [
        "console.log('=== NANOCLAW SETUP: WHATSAPP_AUTH ===');",
        "console.log('STATUS: skipped');",
        "console.log('REASON: creds present');",
        "console.log('=== END ===');",
        'process.exit(0);',
      ].join('\n'),
    );
    process.env.ONCELLCLAW_WA_AUTH_CMD = `node ${stub}`;
    process.env.ONCELLCLAW_WA_AUTH_DIR = path.join(tmp, 'store', 'auth');

    ensureWhatsappPairing();
    await vi.waitFor(() => expect(ensureWhatsappPairing().status).toBe('already_paired'), { timeout: 5000 });
  });

  it('summarizes stderr when the step dies without emitting any block', async () => {
    const stub = path.join(tmp, 'stub.cjs');
    fs.writeFileSync(
      stub,
      "console.error('Error [ERR_MODULE_NOT_FOUND]: Cannot find package \\'qrcode\\'');\nprocess.exit(1);",
    );
    process.env.ONCELLCLAW_WA_AUTH_CMD = `node ${stub}`;
    process.env.ONCELLCLAW_WA_AUTH_DIR = path.join(tmp, 'store', 'auth');

    ensureWhatsappPairing();
    await vi.waitFor(
      () => {
        const state = ensureWhatsappPairing();
        expect(state.status).toBe('failed');
        expect(state.error).toContain('code=1');
        expect(state.error).toContain("Cannot find package 'qrcode'");
      },
      { timeout: 5000 },
    );
  });
});
