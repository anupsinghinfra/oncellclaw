/**
 * Step: set-env — Write or update a KEY=VALUE in .env.
 *
 * Usage:
 *   pnpm exec tsx setup/index.ts --step set-env -- \
 *     --key TELEGRAM_BOT_TOKEN --value "<token>"
 *
 * Exists so channel-install flows don't have to invent grep/sed/rm pipelines
 * (which can't be allowlisted tightly — sed can read any file, and each
 * segment of an && chain is matched separately).
 *
 * Logs the key but never the value.
 */

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

// The canonical writer now lives in src/env.ts so the web channel's pairing
// API and this CLI step share one implementation. Re-exported so existing
// imports of setup/set-env.js keep working.
import { upsertEnvVar } from '../src/env.js';

export { upsertEnvVar };

export async function run(args: string[]): Promise<void> {
  const keyIdx = args.indexOf('--key');
  const valueIdx = args.indexOf('--value');

  if (keyIdx === -1 || !args[keyIdx + 1]) {
    throw new Error('--key <KEY> is required');
  }
  if (valueIdx === -1 || args[valueIdx + 1] === undefined) {
    throw new Error('--value <VALUE> is required');
  }

  const key = args[keyIdx + 1];
  const value = args[valueIdx + 1];

  const { existed } = upsertEnvVar(key, value);
  log.info('Updated .env', { key, existed });

  emitStatus('SET_ENV', {
    KEY: key,
    EXISTED: existed,
    STATUS: 'success',
  });
}
