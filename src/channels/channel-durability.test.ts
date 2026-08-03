/**
 * The update-safety guarantee, enforced rather than documented.
 *
 * A hosted claw is not a long-lived checkout: `scripts/cloud-start.sh`
 * extracts a pristine trunk tarball per commit sha and prunes the old tree,
 * so the ONLY things that survive an update are the paths its `wire_state()`
 * symlinks into `$BASE/state/`. Everything else — an npm dependency a skill
 * installed, an edited `src/channels/index.ts`, a session file dropped beside
 * the code — is gone on the next deploy. That is how hosted WhatsApp pairing
 * came to be impossible, and it would have broken Slack, Signal and every
 * other channel the same way.
 *
 * So the fix could not be "make WhatsApp work". It had to be a rule that
 * holds for the NEXT channel too. The rule (src/durable-state.ts):
 *
 *   a channel is CONFIGURATION, not INSTALLATION — adapter in trunk,
 *   credentials in `.env`, session state under a durable path, and the
 *   registration DECLARES both so it can be checked.
 *
 * These tests are the check. They walk the live registry rather than a list,
 * so a channel added tomorrow is covered the day it lands, and they read
 * cloud-start.sh itself, so the constants can never quietly drift from the
 * shell that implements them.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { DURABLE_DIRS, DURABLE_FILES, DURABLE_PATHS, channelStateDir, isDurablePath } from '../durable-state.js';
import { envFilePath } from '../env.js';
import { getChannelDurability, getRegisteredChannelNames } from './channel-registry.js';
// The real barrel — every trunk channel self-registers on import.
import './index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLOUD_START = path.join(REPO_ROOT, 'scripts', 'cloud-start.sh');
const cloudStart = fs.readFileSync(CLOUD_START, 'utf-8');

/** The body of cloud-start.sh's wire_state() — the shell that does the work. */
function wireStateBody(): string {
  const match = /^wire_state\(\) \{\n([\s\S]*?)\n\}$/m.exec(cloudStart);
  if (!match) throw new Error('wire_state() not found in scripts/cloud-start.sh — did it get renamed?');
  return match[1]!;
}

describe('durable-state — the constants match the shell that implements them', () => {
  it('wire_state() links exactly the directories declared here', () => {
    // `for name in data groups store; do` — the list IS the guarantee.
    const match = /for name in ([a-z .]+); do/.exec(wireStateBody());
    expect(match, 'wire_state() no longer loops over a literal directory list').not.toBeNull();
    expect(match![1]!.trim().split(/\s+/)).toEqual([...DURABLE_DIRS]);
  });

  it('wire_state() links every declared durable file', () => {
    const body = wireStateBody();
    for (const file of DURABLE_FILES) {
      expect(body, `wire_state() does not symlink ${file}`).toContain(`ln -s "$STATE_DIR/${file}"`);
    }
  });

  it('creates the state directories it later links to', () => {
    for (const dir of DURABLE_DIRS) {
      expect(cloudStart).toContain(`$STATE_DIR/${dir}`);
    }
  });

  it('is valid bash', () => {
    // Cheap, and the only automated syntax gate this script has.
    expect(() => execFileSync('bash', ['-n', CLOUD_START])).not.toThrow();
  });
});

describe('durable-state — isDurablePath', () => {
  const root = '/tmp/claw-root';

  it('accepts a wired directory, its contents, and a wired file', () => {
    expect(isDurablePath('store', root)).toBe(true);
    expect(isDurablePath('store/auth', root)).toBe(true);
    expect(isDurablePath('store/auth/creds.json', root)).toBe(true);
    expect(isDurablePath('data/web-files/assistant', root)).toBe(true);
    expect(isDurablePath('.env', root)).toBe(true);
    expect(isDurablePath(`${root}/groups/assistant`, root)).toBe(true);
  });

  it('rejects everything the next update deletes', () => {
    expect(isDurablePath('node_modules/@whiskeysockets/baileys', root)).toBe(false);
    expect(isDurablePath('src/channels/whatsapp.ts', root)).toBe(false);
    expect(isDurablePath('logs/nanoclaw.log', root)).toBe(false);
    expect(isDurablePath('.', root)).toBe(false);
    // A sibling that merely starts with a durable name is not durable.
    expect(isDurablePath('storefront/x', root)).toBe(false);
    // Nor is an escape out of one.
    expect(isDurablePath('store/../src/x.ts', root)).toBe(false);
  });

  it('puts the new-channel helper inside a durable path by construction', () => {
    expect(isDurablePath(channelStateDir('signal', root), root)).toBe(true);
  });
});

describe('channel registrations — every trunk channel declares its durability', () => {
  const channels = getRegisteredChannelNames();

  it('registers the five trunk channels', () => {
    // If this list changes, the per-channel assertions below still apply to
    // whatever is actually registered — this is the canary, not the gate.
    expect(channels.sort()).toEqual(['cli', 'discord', 'telegram', 'web', 'whatsapp']);
  });

  it.each(getRegisteredChannelNames())('%s declares where its credentials and state live', (name) => {
    const durability = getChannelDurability(name);
    expect(
      durability,
      `channel '${name}' has no durability declaration — see src/durable-state.ts. A channel that ` +
        `persists anything outside the wired paths pairs once and goes dark on the next hosted update.`,
    ).toBeDefined();
    expect(Array.isArray(durability!.credentialKeys)).toBe(true);
  });

  it.each(getRegisteredChannelNames())('%s keeps every declared state path inside the wired set', (name) => {
    for (const statePath of getChannelDurability(name)?.statePaths ?? []) {
      expect(
        isDurablePath(statePath, '/tmp/claw-root'),
        `channel '${name}' declares state at '${statePath}', which cloud-start.sh does not preserve. ` +
          `Move it under one of: ${DURABLE_PATHS.join(', ')}.`,
      ).toBe(true);
    }
  });

  it.each(getRegisteredChannelNames())('%s uses UPPER_SNAKE_CASE credential keys the .env writer accepts', (name) => {
    for (const key of getChannelDurability(name)?.credentialKeys ?? []) {
      // upsertEnvVar (src/env.ts) throws on anything else, so a bad key here
      // would be a pairing endpoint that 500s the first time it is used.
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('routes every credential through the one durable .env file', () => {
    // The convention's other half: credentials are not a per-channel store.
    // They go to `.env` via upsertEnvVar, and `.env` is wired into state/.
    const declared = channels.flatMap((name) => getChannelDurability(name)?.credentialKeys ?? []);
    expect(declared).toContain('TELEGRAM_BOT_TOKEN');
    expect(declared).toContain('DISCORD_BOT_TOKEN');
    expect(isDurablePath(envFilePath())).toBe(true);
  });
});

/**
 * Run cloud-start's orphan warner for real, against a scratch state dir and a
 * scratch checkout. The shell is extracted rather than sourced — the script
 * has top-level work (it binds a port, downloads a tarball) that must not run
 * in a test — so this executes the exact lines shipped, nothing rewritten.
 */
function runOrphanWarner(env: string | null, barrel: string): { out: string; code: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-orphan-'));
  try {
    const stateDir = path.join(root, 'state');
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(checkout, 'src', 'channels'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'src', 'channels', 'index.ts'), barrel);
    if (env !== null) fs.writeFileSync(path.join(stateDir, '.env'), env);

    const shell = /^(ORPHANABLE_CHANNELS='[\s\S]*?^warn_orphaned_channels\(\) \{[\s\S]*?^\})$/m.exec(cloudStart);
    if (!shell) throw new Error('could not extract the orphan warner from scripts/cloud-start.sh');

    const out = execFileSync(
      'bash',
      ['-c', `set -euo pipefail\nSTATE_DIR=${JSON.stringify(stateDir)}\n${shell[1]}\nwarn_orphaned_channels`],
      { cwd: checkout, encoding: 'utf-8' },
    );
    return { out, code: 0 };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const TRUNK_BARREL = "import './cli.js';\nimport './telegram.js';\nimport './whatsapp.js';\n";

describe('the hosted posture warns about channels it cannot keep', () => {
  /**
   * Some channels genuinely cannot be trunk-ified — they need an LLM-driven
   * skill to install code into the checkout. On a hosted claw that install
   * evaporates on the next deploy while its credential stays behind in the
   * durable `.env`, which reads to a user as "my Slack just stopped working"
   * with nothing in the logs. cloud-start says so instead.
   */
  it('names the skill-installed channels it checks for', () => {
    expect(cloudStart).toContain('warn_orphaned_channels');
    for (const key of ['SLACK_BOT_TOKEN', 'SIGNAL_ACCOUNT', 'MATRIX_ACCESS_TOKEN']) {
      expect(cloudStart).toContain(key);
    }
  });

  it('warns rather than dying — a stale key must never brick a booting claw', () => {
    const body = /^warn_orphaned_channels\(\) \{\n([\s\S]*?)\n\}$/m.exec(cloudStart)?.[1] ?? '';
    expect(body).not.toBe('');
    expect(body).not.toContain('die ');
    expect(body).not.toContain('exit 1');
  });

  it('names exactly the orphaned channels, and exits clean', () => {
    const { out } = runOrphanWarner(
      'SLACK_BOT_TOKEN=xoxb-1\nWHATSAPP_ACCESS_TOKEN=abc\nTELEGRAM_BOT_TOKEN=123\n',
      TRUNK_BARREL,
    );

    expect(out).toContain('UNSUPPORTED CHANNEL CREDENTIALS');
    expect(out).toContain('slack');
    expect(out).toContain('whatsapp-cloud'); // the Meta Business API channel, still skill-installed
    // Trunk channels are never reported, even though their keys are present.
    expect(out).not.toMatch(/: .*\btelegram\b/);
  });

  it('says nothing when every configured channel is one trunk ships', () => {
    expect(runOrphanWarner('TELEGRAM_BOT_TOKEN=123\nDISCORD_BOT_TOKEN=abc\n', TRUNK_BARREL).out).toBe('');
  });

  it('says nothing when there is no .env at all — a first boot is not a warning', () => {
    expect(runOrphanWarner(null, TRUNK_BARREL).out).toBe('');
  });

  it('stops reporting a channel the day its adapter graduates into trunk', () => {
    const graduated = `${TRUNK_BARREL}import './slack.js';\n`;
    expect(runOrphanWarner('SLACK_BOT_TOKEN=xoxb-1\n', graduated).out).toBe('');
  });
});
