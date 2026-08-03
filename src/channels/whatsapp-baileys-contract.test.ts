/**
 * The one place the real Baileys package is touched.
 *
 * src/channels/whatsapp.ts loads Baileys through `import('… as string')`,
 * which deliberately hands tsc `any` — the package is an OPTIONAL trunk
 * dependency and a typecheck must not require it on disk. The cost of that
 * choice is that nothing type-checks the adapter against the real module, and
 * the gap only shows up at pairing time on someone's phone.
 *
 * So: assert the contract by hand, offline. Every symbol
 * `defaultSocketFactory` reaches for, the numeric disconnect reason the
 * reconnect logic branches on, and the fact that `useMultiFileAuthState`
 * writes the exact `creds.json` the adapter factory gates on. No network, no
 * socket, no WhatsApp — just the module surface and one temp directory.
 *
 * Skipped (not failed) when the optional dependency is genuinely absent, so a
 * `--no-optional` checkout can still run the suite. CI installs it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { WHATSAPP_OPTIONAL_DEPS, isWhatsappPaired } from './whatsapp-session.js';

/** Is the optional dependency actually installed in this checkout? */
async function baileysInstalled(): Promise<boolean> {
  try {
    await import('@whiskeysockets/baileys' as string);
    return true;
  } catch {
    return false;
  }
}

const installed = await baileysInstalled();

describe.skipIf(!installed)('baileys — the surface the trunk adapter depends on', () => {
  it('exports every symbol defaultSocketFactory calls', async () => {
    const baileys = (await import('@whiskeysockets/baileys' as string)) as Record<string, unknown>;

    for (const name of [
      'makeWASocket',
      'useMultiFileAuthState',
      'makeCacheableSignalKeyStore',
      'fetchLatestWaWebVersion',
    ]) {
      expect(typeof baileys[name], `@whiskeysockets/baileys no longer exports ${name}`).toBe('function');
    }
    expect(typeof (baileys.Browsers as { macOS?: unknown } | undefined)?.macOS).toBe('function');
  });

  it('still numbers loggedOut 401 — the reconnect branch is keyed on it', async () => {
    const { DisconnectReason } = (await import('@whiskeysockets/baileys' as string)) as {
      DisconnectReason: Record<string, number>;
    };
    // whatsapp.ts hardcodes 401 rather than importing the enum (the enum
    // would drag the module in eagerly). If Baileys ever renumbers it, the
    // adapter would reconnect forever against dead credentials.
    expect(DisconnectReason.loggedOut).toBe(401);
  });

  it('writes the creds.json the adapter factory treats as "paired"', async () => {
    const { useMultiFileAuthState } = (await import('@whiskeysockets/baileys' as string)) as {
      useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-contract-'));
    const previous = process.env.ONCELLCLAW_WA_AUTH_DIR;
    process.env.ONCELLCLAW_WA_AUTH_DIR = dir;
    try {
      expect(isWhatsappPaired()).toBe(false);

      const { saveCreds } = await useMultiFileAuthState(dir);
      await saveCreds();

      // The whole credential model in one assertion: Baileys' own writer
      // produces the file the factory gates on, in the directory the
      // durability declaration names.
      expect(fs.readdirSync(dir)).toContain('creds.json');
      expect(isWhatsappPaired()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ONCELLCLAW_WA_AUTH_DIR;
      else process.env.ONCELLCLAW_WA_AUTH_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has pino as a callable named export', async () => {
    const mod = (await import('pino' as string)) as { pino?: unknown };
    expect(typeof mod.pino).toBe('function');
  });

  it('is pinned as an optional dependency, not a hard one', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
    };

    for (const dep of WHATSAPP_OPTIONAL_DEPS) {
      expect(pkg.optionalDependencies[dep], `${dep} must stay an optional dependency`).toBeDefined();
      expect(pkg.dependencies[dep]).toBeUndefined();
      // Exact versions only — the supply-chain policy rejects ranges.
      expect(pkg.optionalDependencies[dep]).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});
