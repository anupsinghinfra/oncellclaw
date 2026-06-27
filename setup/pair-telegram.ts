/**
 * Step: pair-telegram — issue a one-time pairing code and wait for the
 * operator to send the code from the chat they want to register.
 *
 * Emits machine-readable status blocks only. The parent driver
 * (`setup:auto`) renders the code / attempt / success UI with clack. Running
 * this step directly will look sparse — that's intentional.
 *
 * Blocks emitted:
 *   PAIR_TELEGRAM_CODE       { CODE, REASON=initial|regenerated }
 *   PAIR_TELEGRAM_ATTEMPT    { CANDIDATE }
 *   PAIR_TELEGRAM (final)    { STATUS=success, CODE, INTENT, PLATFORM_ID,
 *                              IS_GROUP, PAIRED_USER_ID }
 *                         or { STATUS=failed, CODE, ERROR }
 *
 * Depends on src/channels/telegram-pairing.js, which the /add-telegram skill
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

/**
 * Render the pairing code and live feedback as PLAIN stdout lines.
 *
 * The Option A driver's streaming exec (setup/lib/skill-driver.ts
 * `hostExecStream`) CONSUMES the `=== NANOCLAW SETUP: … ===` status blocks (it
 * does not show them) and tees every OTHER stdout line straight to the
 * operator's terminal. So the human-facing code card has to be printed as plain
 * lines here — the bespoke setup/channels/telegram.ts used to render these from
 * the blocks, and that rendering now lives in the step itself. The structured
 * blocks are still emitted alongside for the agent-driven callers
 * (/manage-channels, /init-first-agent) that parse them.
 */
function printCodeCard(code: string, reason: 'initial' | 'regenerated'): void {
  const spaced = code.split('').join('   ');
  console.log('');
  console.log(
    reason === 'initial'
      ? 'Your pairing code is ready.'
      : 'That code was used up — here is a fresh one.',
  );
  console.log('');
  console.log(`    ${spaced}`);
  console.log('');
  console.log('Send these 4 digits to your bot from Telegram.');
  console.log('Waiting for you to send the code…');
}

function printAttempt(candidate: string): void {
  console.log(`Got "${candidate}", which doesn't match — waiting for the correct code…`);
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
  printCodeCard(record.code, 'initial');
  emitStatus('PAIR_TELEGRAM_CODE', {
    CODE: record.code,
    REASON: 'initial',
  });

  for (let regen = 0; regen <= MAX_REGENERATIONS; regen++) {
    try {
      const consumed = await waitForPairing(record.code, {
        onAttempt: (a) => {
          printAttempt(a.candidate);
          emitStatus('PAIR_TELEGRAM_ATTEMPT', {
            CANDIDATE: a.candidate,
          });
        },
      });

      console.log('\nTelegram paired.');
      emitStatus('PAIR_TELEGRAM', {
        STATUS: 'success',
        CODE: record.code,
        INTENT: intentToString(consumed.intent),
        PLATFORM_ID: consumed.consumed!.platformId,
        IS_GROUP: consumed.consumed!.isGroup,
        // Bare Telegram user id (no prefix). The Option A driver captures this as
        // `owner_handle`, and run-channel-skill composes `telegram:<owner_handle>`
        // — byte-identical to the legacy PAIRED_USER_ID below. PAIRED_USER_ID
        // stays for the agent-driven callers that read it directly.
        ADMIN_USER_ID: consumed.consumed!.adminUserId ?? '',
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
        printCodeCard(record.code, 'regenerated');
        emitStatus('PAIR_TELEGRAM_CODE', {
          CODE: record.code,
          REASON: 'regenerated',
        });
        continue;
      }
      const reason = invalidated ? 'max-regenerations-exceeded' : message;
      emitStatus('PAIR_TELEGRAM', {
        STATUS: 'failed',
        CODE: record.code,
        ERROR: reason,
      });
      process.exit(2);
    }
  }
}
