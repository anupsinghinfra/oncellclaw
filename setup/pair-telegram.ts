/**
 * Step: pair-telegram — issue a one-time pairing code and wait for the
 * operator to send `@botname CODE` from the chat they want to register.
 *
 * On success, prints platformId / isGroup / adminUserId / intent. The caller
 * (skill) then runs `setup --step register` with those values.
 *
 * The service must already be running so the telegram adapter is polling.
 */
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { DATA_DIR } from '../src/config.js';
import path from 'path';

import {
  createPairing,
  waitForPairing,
  type PairingIntent,
} from '../src/channels/telegram-pairing.js';
import { emitStatus } from './status.js';

interface Args {
  intent: PairingIntent;
  ttlMs: number;
}

function parseArgs(args: string[]): Args {
  let intent: PairingIntent = 'main';
  let ttlMs = 5 * 60 * 1000;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--intent': {
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
        break;
      }
      case '--ttl-ms':
        ttlMs = parseInt(args[++i] || '300000', 10);
        break;
    }
  }
  return { intent, ttlMs };
}

function intentToString(intent: PairingIntent): string {
  if (intent === 'main') return 'main';
  return `${intent.kind}:${intent.folder}`;
}

export async function run(args: string[]): Promise<void> {
  const { intent, ttlMs } = parseArgs(args);

  // Pairing reads/writes its JSON store under DATA_DIR; the DB isn't strictly
  // required for the pairing primitive itself, but the inbound interceptor
  // (running in the live service) needs it. Touch it here so a fresh install
  // doesn't blow up on the first match.
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const record = await createPairing(intent, { ttlMs });

  // Tell the user what to do. The skill prints this as user-facing text.
  emitStatus('PAIR_TELEGRAM_ISSUED', {
    CODE: record.code,
    INTENT: intentToString(intent),
    EXPIRES_AT: record.expiresAt,
    INSTRUCTIONS: `Send "@<botname> ${record.code}" from the Telegram chat you want to register.`,
  });

  try {
    const consumed = await waitForPairing(record.code, { timeoutMs: ttlMs });
    emitStatus('PAIR_TELEGRAM', {
      STATUS: 'success',
      CODE: record.code,
      INTENT: intentToString(consumed.intent),
      PLATFORM_ID: consumed.consumed!.platformId,
      IS_GROUP: consumed.consumed!.isGroup,
      ADMIN_USER_ID: consumed.consumed!.adminUserId ?? '',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitStatus('PAIR_TELEGRAM', {
      STATUS: 'failed',
      CODE: record.code,
      ERROR: message,
    });
    process.exit(2);
  }
}
