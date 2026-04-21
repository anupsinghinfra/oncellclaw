/**
 * Telegram channel flow for setup:auto.
 *
 * `runTelegramChannel(displayName)` owns the full branch from the
 * BotFather instructions through the welcome DM:
 *
 *   1. BotFather instructions (clack note)
 *   2. Paste the bot token (clack password) — format-validated
 *   3. getMe via the Bot API to resolve the bot's username
 *   4. Install the adapter (setup/add-telegram.sh, non-interactive)
 *   5. Run the pair-telegram step, rendering code events as clack notes
 *   6. Ask for the messaging-agent name (defaulting to "Nano")
 *   7. Wire the agent via scripts/init-first-agent.ts
 *
 * All output obeys the three-level contract: clack UI for the user,
 * structured entries in logs/setup.log, full raw output in per-step files
 * under logs/setup-steps/. See docs/setup-flow.md.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import {
  type Block,
  type StepResult,
  dumpTranscriptOnFailure,
  ensureAnswer,
  fail,
  runQuietChild,
  spawnStep,
  writeStepEntry,
} from '../lib/runner.js';
import { brandBold } from '../lib/theme.js';

const DEFAULT_AGENT_NAME = 'Nano';

export async function runTelegramChannel(displayName: string): Promise<void> {
  const token = await collectTelegramToken();
  const botUsername = await validateTelegramToken(token);

  const install = await runQuietChild(
    'telegram-install',
    'bash',
    ['setup/add-telegram.sh'],
    {
      running: `Installing Telegram adapter and wiring @${botUsername}…`,
      done: 'Telegram adapter ready.',
    },
    {
      env: { TELEGRAM_BOT_TOKEN: token },
      extraFields: { BOT_USERNAME: botUsername },
    },
  );
  if (!install.ok) {
    fail(
      'telegram-install',
      'Telegram install failed.',
      'Check the raw log under logs/setup-steps/, then retry `pnpm run setup:auto`.',
    );
  }

  const pair = await runPairTelegram();
  if (!pair.ok) {
    fail(
      'pair-telegram',
      'Telegram pairing failed.',
      'Re-run `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main`.',
    );
  }

  const platformId = pair.terminal?.fields.PLATFORM_ID;
  const pairedUserId = pair.terminal?.fields.PAIRED_USER_ID;
  if (!platformId || !pairedUserId) {
    fail(
      'pair-telegram',
      'pair-telegram succeeded but did not return PLATFORM_ID and PAIRED_USER_ID.',
      'Re-run `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main` and capture the success block.',
    );
  }

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'telegram',
      '--user-id', pairedUserId,
      '--platform-id', platformId,
      '--display-name', displayName,
      '--agent-name', agentName,
    ],
    {
      running: `Wiring ${agentName} to your Telegram chat…`,
      done: `${agentName} is wired — welcome DM incoming.`,
    },
    {
      extraFields: { CHANNEL: 'telegram', AGENT_NAME: agentName, PLATFORM_ID: platformId },
    },
  );
  if (!init.ok) {
    fail(
      'init-first-agent',
      'Wiring the Telegram agent failed.',
      `Re-run \`pnpm exec tsx scripts/init-first-agent.ts --channel telegram --user-id "${pairedUserId}" --platform-id "${platformId}" --display-name "${displayName}" --agent-name "${agentName}"\`.`,
    );
  }
}

async function collectTelegramToken(): Promise<string> {
  p.note(
    [
      '1. Open Telegram and message @BotFather',
      '2. Send: /newbot',
      '3. Follow the prompts (name + username ending in "bot")',
      '4. Copy the token it gives you (format: <digits>:<chars>)',
      '',
      k.dim('Optional, but recommended for groups:'),
      k.dim('    @BotFather → /mybots → Bot Settings → Group Privacy → OFF'),
    ].join('\n'),
    'Create a Telegram bot',
  );

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your bot token',
      validate: (v) => {
        if (!v || !v.trim()) return 'Token is required';
        if (!/^[0-9]+:[A-Za-z0-9_-]{35,}$/.test(v.trim())) {
          return 'Format looks wrong — expected <digits>:<chars>';
        }
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();
  setupLog.userInput(
    'telegram_token',
    `${token.slice(0, 12)}…${token.slice(-4)}`,
  );
  return token;
}

async function validateTelegramToken(token: string): Promise<string> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Validating token with Telegram…');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as {
      ok?: boolean;
      result?: { username?: string; id?: number };
      description?: string;
    };
    const elapsedS = Math.round((Date.now() - start) / 1000);
    if (data.ok && data.result?.username) {
      const username = data.result.username;
      s.stop(`Bot is @${username}. ${k.dim(`(${elapsedS}s)`)}`);
      setupLog.step('telegram-validate', 'success', Date.now() - start, {
        BOT_USERNAME: username,
        BOT_ID: data.result.id ?? '',
      });
      return username;
    }
    const reason = data.description ?? 'token rejected by Telegram';
    s.stop(`Telegram rejected the token: ${reason}`, 1);
    setupLog.step('telegram-validate', 'failed', Date.now() - start, {
      ERROR: reason,
    });
    fail(
      'telegram-validate',
      'Telegram rejected the token.',
      'Double-check the token (copy it again from @BotFather) and retry.',
    );
  } catch (err) {
    const elapsedS = Math.round((Date.now() - start) / 1000);
    s.stop(`Could not reach Telegram. ${k.dim(`(${elapsedS}s)`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('telegram-validate', 'failed', Date.now() - start, {
      ERROR: message,
    });
    fail(
      'telegram-validate',
      'Telegram API unreachable.',
      'Check your network connection and retry.',
    );
  }
}

async function runPairTelegram(): Promise<
  StepResult & { rawLog: string; durationMs: number }
> {
  const rawLog = setupLog.stepRawLog('pair-telegram');
  const start = Date.now();
  const s = p.spinner();
  s.start('Creating pairing code…');
  let spinnerActive = true;

  const stopSpinner = (msg: string, code?: number) => {
    if (spinnerActive) {
      s.stop(msg, code);
      spinnerActive = false;
    }
  };

  const result = await spawnStep(
    'pair-telegram',
    ['--intent', 'main'],
    (block: Block) => {
      if (block.type === 'PAIR_TELEGRAM_CODE') {
        const reason = block.fields.REASON ?? 'initial';
        if (reason === 'initial') {
          stopSpinner('Pairing code ready.');
        } else {
          stopSpinner('Previous code invalidated. New code below.');
        }
        p.note(formatCodeCard(block.fields.CODE ?? '????'), 'Pairing code');
        s.start('Waiting for the code from Telegram…');
        spinnerActive = true;
      } else if (block.type === 'PAIR_TELEGRAM_ATTEMPT') {
        stopSpinner(`Received "${block.fields.CANDIDATE ?? '?'}" — doesn't match.`);
        s.start('Waiting for the correct code…');
        spinnerActive = true;
      } else if (block.type === 'PAIR_TELEGRAM') {
        if (block.fields.STATUS === 'success') {
          stopSpinner('Telegram paired.');
        } else {
          stopSpinner(`Pairing failed: ${block.fields.ERROR ?? 'unknown'}`, 1);
        }
      }
    },
    rawLog,
  );
  const durationMs = Date.now() - start;

  // Safety net: if the child died without emitting a terminal block, make
  // sure we don't leave the spinner running.
  if (spinnerActive) {
    stopSpinner(
      result.ok ? 'Done.' : 'Pairing exited unexpectedly.',
      result.ok ? 0 : 1,
    );
    if (!result.ok) dumpTranscriptOnFailure(result.transcript);
  }

  writeStepEntry('pair-telegram', result, durationMs, rawLog);
  return { ...result, rawLog, durationMs };
}

function formatCodeCard(code: string): string {
  const spaced = code.split('').join('   ');
  return [
    '',
    `   ${brandBold(spaced)}`,
    '',
    k.dim('   Send these digits from Telegram to your bot.'),
  ].join('\n');
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your messaging agent be called?',
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  const value = (answer as string).trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}
