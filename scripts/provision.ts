/**
 * Non-interactive provisioning CLI — the scripted equivalent of `pnpm setup`
 * for a web-channel instance.
 *
 * Opens the central DB, runs migrations, and converges one agent group that
 * is paired to the `web` channel. Safe to run on every boot: every step is
 * idempotent, so a second run creates nothing and exits 0.
 *
 * Usage:
 *   pnpm exec tsx scripts/provision.ts --group assistant \
 *     [--display-name "Andy"] \
 *     [--persona "You are ..." | --persona-file ./persona.md] \
 *     [--provider claude] \
 *     [--owner owner]
 *
 * Called by scripts/cloud-start.sh; equally usable by hand.
 */
import fs from 'fs';
import path from 'path';

// Registration-only barrel import: channel modules call
// registerChannelAdapter() at module scope — no factory runs, nothing
// connects, no HTTP port is opened — so the `web` channel's declared
// defaults resolve here without a live adapter.
import '../src/channels/index.js';
import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { provisionWebGroup, type ProvisionWebGroupOptions } from '../src/web-provision.js';

interface Args extends ProvisionWebGroupOptions {
  personaFile?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--group':
        out.group = val;
        i++;
        break;
      case '--display-name':
        out.displayName = val;
        i++;
        break;
      case '--persona':
        out.persona = val;
        i++;
        break;
      case '--persona-file':
        out.personaFile = val;
        i++;
        break;
      case '--provider':
        out.provider = val;
        i++;
        break;
      case '--owner':
        out.ownerHandle = val;
        i++;
        break;
      default:
        console.error(`Unknown argument: ${key}`);
        console.error('See scripts/provision.ts header for usage.');
        process.exit(2);
    }
  }

  if (!out.group) {
    console.error('Missing required arg: --group');
    console.error('See scripts/provision.ts header for usage.');
    process.exit(2);
  }

  if (out.personaFile) {
    // An empty/whitespace persona file is treated as "no persona" so an
    // unset ONCELLCLAW_PERSONA can be piped through without special-casing.
    const text = fs.readFileSync(out.personaFile, 'utf-8');
    if (text.trim()) out.persona = text;
  }

  return out as Args;
}

const args = parseArgs(process.argv.slice(2));

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const result = provisionWebGroup(args);

console.log('');
console.log(result.created.agentGroup ? 'Provisioned a new agent group.' : 'Agent group already provisioned.');
console.log(`  group:   ${result.slug}`);
console.log(`  agent:   ${result.agentGroupId} @ groups/${result.slug}`);
console.log(`  channel: web/${result.slug} [${result.messagingGroupId}]`);
console.log(`  owner:   ${result.ownerUserId}`);
console.log(
  `  created: ${
    Object.entries(result.created)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ') || 'nothing (idempotent re-run)'
  }`,
);
console.log('');
