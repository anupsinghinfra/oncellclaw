/**
 * Step: pair-telegram — issue a one-time pairing code and wait for the
 * operator to send the code from the chat they want to register.
 *
 * Used exclusively by `setup:auto` / `bash nanoclaw.sh` on this branch. Human-
 * facing output is a focused banner for the code (no parseable block), plus a
 * short line for wrong attempts / regenerations. A single machine-readable
 * PAIR_TELEGRAM status block is still emitted at the end so the parent driver
 * can pick up PLATFORM_ID / PAIRED_USER_ID / IS_GROUP.
 *
 * Depends on src/channels/telegram-pairing.js, which setup/add-telegram.sh
 * copies in from the `channels` branch before this step runs. setup/ is
 * excluded from the host tsconfig, so this file's import resolves only at
 * runtime — tsc won't complain on branches that haven't run add-telegram yet.
 */
import path from 'path';

import {
  createPairing,
  waitForPairing,
  type PairingIntent,
} from '../src/channels/telegram-pairing.js';
import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

import { emitStatus } from './status.js';

function parseArgs(args: string[]): PairingIntent {
  let intent: PairingIntent = 'main';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--intent') {
      const raw = args[++i] || 'main';
      if (raw === 'main') {
        intent = 'main';
      } else if (raw.startsWith('wire-to:')) {
        intent = { kind: 'wire-to', folder: raw.slice('wire-to:'.length) };
      } else if (raw.startsWith('new-agent:')) {
        intent = { kind: 'new-agent', folder: raw.slice('new-agent:'.length) };
      } else {
        throw new Error(`Unknown intent: ${raw}`);
      }
    }
  }
  return intent;
}

function intentToString(intent: PairingIntent): string {
  if (intent === 'main') return 'main';
  return `${intent.kind}:${intent.folder}`;
}

function printCodeBanner(code: string): void {
  const digits = code.split('').join('  ');
  const content = [
    '',
    `     PAIRING CODE:   ${digits}`,
    '',
    '     Send these digits from Telegram to your bot.',
    '',
  ];
  const width = Math.max(...content.map((l) => l.length));
  const top = '  ╔' + '═'.repeat(width + 2) + '╗';
  const bot = '  ╚' + '═'.repeat(width + 2) + '╝';
  const mid = content.map((l) => '  ║ ' + l.padEnd(width) + ' ║');
  console.log(['', top, ...mid, bot, ''].join('\n'));
}

export async function run(args: string[]): Promise<void> {
  const intent = parseArgs(args);

  // Pairing stores state under DATA_DIR; the DB isn't strictly needed for the
  // pairing primitive itself, but the inbound interceptor running inside the
  // live service needs migrations applied. Touch it here so a fresh install
  // doesn't fail on the first code match.
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const MAX_REGENERATIONS = 5;
  let record = await createPairing(intent);
  printCodeBanner(record.code);

  for (let regen = 0; regen <= MAX_REGENERATIONS; regen++) {
    try {
      const consumed = await waitForPairing(record.code, {
        onAttempt: (a) => {
          console.log(
            `   Got "${a.candidate}" — doesn't match. A new code is on its way.`,
          );
        },
      });

      console.log('\n   ✓ Telegram paired.\n');
      emitStatus('PAIR_TELEGRAM', {
        STATUS: 'success',
        CODE: record.code,
        INTENT: intentToString(consumed.intent),
        PLATFORM_ID: consumed.consumed!.platformId,
        IS_GROUP: consumed.consumed!.isGroup,
        PAIRED_USER_ID: consumed.consumed!.adminUserId
          ? `telegram:${consumed.consumed!.adminUserId}`
          : '',
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const invalidated = /invalidated by wrong code/.test(message);
      if (invalidated && regen < MAX_REGENERATIONS) {
        record = await createPairing(intent);
        console.log('\n   Previous code invalidated. New code:');
        printCodeBanner(record.code);
        continue;
      }
      const reason = invalidated ? 'max-regenerations-exceeded' : message;
      console.error(`\n   ✗ Pairing failed: ${reason}`);
      emitStatus('PAIR_TELEGRAM', {
        STATUS: 'failed',
        CODE: record.code,
        ERROR: reason,
      });
      process.exit(2);
    }
  }
}
