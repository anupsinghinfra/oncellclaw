/**
 * Non-interactive setup driver — the step sequencer for `pnpm run setup:auto`.
 *
 * Responsibility: orchestrate the sequence of steps end-to-end and route
 * between them. The runner, spawning, status parsing, spinner, abort, and
 * prompt primitives live in `setup/lib/runner.ts`; theming in
 * `setup/lib/theme.ts`; Telegram's full flow in `setup/channels/telegram.ts`.
 *
 * Config via env:
 *   NANOCLAW_DISPLAY_NAME  how the agents address the operator — skips the
 *                          prompt. Defaults to $USER.
 *   NANOCLAW_AGENT_NAME    messaging-channel agent name (consumed by the
 *                          channel flow). The CLI scratch agent is always
 *                          "Terminal Agent".
 *   NANOCLAW_SKIP          comma-separated step names to skip
 *                          (environment|container|onecli|auth|mounts|
 *                           service|cli-agent|channel|verify)
 *
 * Timezone defaults to the host system's TZ. Run
 *   pnpm exec tsx setup/index.ts --step timezone -- --tz <zone>
 * later if autodetect is wrong.
 */
import { spawn, spawnSync } from 'child_process';

import * as p from '@clack/prompts';
import k from 'kleur';

import { runTelegramChannel } from './channels/telegram.js';
import * as setupLog from './logs.js';
import { ensureAnswer, fail, runQuietStep } from './lib/runner.js';
import { brandBold, brandChip } from './lib/theme.js';

const CLI_AGENT_NAME = 'Terminal Agent';
const RUN_START = Date.now();

async function main(): Promise<void> {
  printIntro();
  initProgressionLog();

  const skip = new Set(
    (process.env.NANOCLAW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!skip.has('environment')) {
    const res = await runQuietStep('environment', {
      running: 'Checking environment…',
      done: 'Environment OK.',
    });
    if (!res.ok) fail('environment', 'Environment check failed.');
  }

  if (!skip.has('container')) {
    const res = await runQuietStep('container', {
      running: 'Building the agent container image…',
      done: 'Container image ready.',
      failed: 'Container build failed.',
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'runtime_not_available') {
        fail(
          'container',
          'Docker is not available and could not be started automatically.',
          'Install Docker Desktop or start it manually, then retry.',
        );
      }
      if (err === 'docker_group_not_active') {
        fail(
          'container',
          'Docker was just installed but your shell is not yet in the `docker` group.',
          'Log out and back in (or run `newgrp docker` in a new shell), then retry.',
        );
      }
      fail(
        'container',
        'Container build/test failed.',
        'For stale cache: `docker builder prune -f`, then retry `pnpm run setup:auto`.',
      );
    }
    maybeReexecUnderSg();
  }

  if (!skip.has('onecli')) {
    const res = await runQuietStep('onecli', {
      running: 'Installing OneCLI credential vault…',
      done: 'OneCLI installed.',
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'onecli_not_on_path_after_install') {
        fail(
          'onecli',
          'OneCLI installed but not on PATH.',
          'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"`, then retry.',
        );
      }
      fail(
        'onecli',
        `OneCLI install failed (${err ?? 'unknown'}).`,
        'Check that curl + a writable ~/.local/bin are available, then retry.',
      );
    }
  }

  if (!skip.has('auth')) {
    if (anthropicSecretExists()) {
      p.log.success('OneCLI already has an Anthropic secret — skipping.');
      setupLog.step('auth', 'skipped', 0, { REASON: 'secret-already-present' });
    } else {
      p.log.step('Registering your Anthropic credential…');
      console.log(
        k.dim('   (browser sign-in or paste a token/key — this part is interactive)'),
      );
      console.log();
      const start = Date.now();
      const code = await runInheritScript('bash', ['setup/register-claude-token.sh']);
      const durationMs = Date.now() - start;
      console.log();
      if (code !== 0) {
        setupLog.step('auth', 'failed', durationMs, { EXIT_CODE: code });
        fail(
          'auth',
          'Anthropic credential registration failed or was aborted.',
          'Re-run `bash setup/register-claude-token.sh` or handle via `/setup` §4.',
        );
      }
      setupLog.step('auth', 'interactive', durationMs, {
        METHOD: 'register-claude-token.sh',
      });
      p.log.success('Anthropic credential registered with OneCLI.');
    }
  }

  if (!skip.has('mounts')) {
    const res = await runQuietStep(
      'mounts',
      {
        running: 'Writing mount allowlist…',
        done: 'Mount allowlist in place.',
        skipped: 'Mount allowlist already configured.',
      },
      ['--empty'],
    );
    if (!res.ok) fail('mounts', 'Mount allowlist step failed.');
  }

  if (!skip.has('service')) {
    const res = await runQuietStep('service', {
      running: 'Installing the background service…',
      done: 'Service installed and running.',
    });
    if (!res.ok) {
      fail(
        'service',
        'Service install failed.',
        'Check logs/nanoclaw.error.log, or run `/setup` to iterate interactively.',
      );
    }
    if (res.terminal?.fields.DOCKER_GROUP_STALE === 'true') {
      p.log.warn('Docker group stale in systemd session.');
      p.log.message(
        k.dim(
          '  sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' +
            '  systemctl --user restart nanoclaw',
        ),
      );
    }
  }

  let displayName: string | undefined;
  const needsDisplayName = !skip.has('cli-agent') || !skip.has('channel');
  if (needsDisplayName) {
    const fallback = process.env.USER?.trim() || 'Operator';
    const preset = process.env.NANOCLAW_DISPLAY_NAME?.trim();
    displayName = preset || (await askDisplayName(fallback));
  }

  if (!skip.has('cli-agent')) {
    const res = await runQuietStep(
      'cli-agent',
      {
        running: 'Wiring the terminal agent…',
        done: 'Terminal agent wired (try `pnpm run chat hi`).',
      },
      ['--display-name', displayName!, '--agent-name', CLI_AGENT_NAME],
    );
    if (!res.ok) {
      fail(
        'cli-agent',
        'CLI agent wiring failed.',
        `Re-run \`pnpm exec tsx scripts/init-cli-agent.ts --display-name "${displayName!}" --agent-name "${CLI_AGENT_NAME}"\` to fix.`,
      );
    }
  }

  if (!skip.has('channel')) {
    const choice = await askChannelChoice();
    if (choice === 'telegram') {
      await runTelegramChannel(displayName!);
    } else {
      p.log.info('No messaging channel wired — you can add one later with `/add-<channel>`.');
    }
  }

  if (!skip.has('verify')) {
    const res = await runQuietStep('verify', {
      running: 'Verifying the install…',
      done: 'Install verified.',
      failed: 'Verification found issues.',
    });
    if (!res.ok) {
      const notes: string[] = [];
      if (res.terminal?.fields.CREDENTIALS !== 'configured') {
        notes.push('• Anthropic secret not detected — re-run `bash setup/register-claude-token.sh`.');
      }
      const agentPing = res.terminal?.fields.AGENT_PING;
      if (agentPing && agentPing !== 'ok' && agentPing !== 'skipped') {
        notes.push(
          `• CLI agent did not reply (status: ${agentPing}). ` +
            'Check `logs/nanoclaw.log` and `groups/*/logs/container-*.log`, then try `pnpm run chat hi`.',
        );
      }
      if (!res.terminal?.fields.CONFIGURED_CHANNELS) {
        notes.push('• Optional: add a messaging channel — `/add-discord`, `/add-slack`, `/add-telegram`, …');
      }
      if (notes.length > 0) {
        p.note(notes.join('\n'), 'What’s left');
      }
      p.outro(k.yellow('Scripted steps done — some pieces still need you.'));
      return;
    }
  }

  const nextSteps = [
    `${k.cyan('Chat from the CLI:')}     pnpm run chat hi`,
    `${k.cyan('Tail host logs:')}        tail -f logs/nanoclaw.log`,
    `${k.cyan('Open Claude Code:')}      claude`,
  ].join('\n');
  p.note(nextSteps, 'Next steps');
  setupLog.complete(Date.now() - RUN_START);
  p.outro(k.green('Setup complete.'));
}

// ─── prompts owned by the sequencer ────────────────────────────────────

async function askDisplayName(fallback: string): Promise<string> {
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your agents call you?',
      placeholder: fallback,
      defaultValue: fallback,
    }),
  );
  const value = (answer as string).trim() || fallback;
  setupLog.userInput('display_name', value);
  return value;
}

async function askChannelChoice(): Promise<'telegram' | 'skip'> {
  const choice = ensureAnswer(
    await p.select({
      message: 'Connect a messaging app so you can chat from your phone?',
      options: [
        { value: 'telegram', label: 'Telegram', hint: 'recommended' },
        { value: 'skip', label: 'Skip — use the CLI only' },
      ],
    }),
  );
  setupLog.userInput('channel_choice', String(choice));
  return choice as 'telegram' | 'skip';
}

// ─── interactive / env helpers ─────────────────────────────────────────

function anthropicSecretExists(): boolean {
  try {
    const res = spawnSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return false;
    return /anthropic/i.test(res.stdout ?? '');
  } catch {
    return false;
  }
}

function runInheritScript(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * After installing Docker, this process's supplementary groups are still
 * frozen from login — subsequent steps that talk to /var/run/docker.sock
 * (onecli install, service start, …) fail with EACCES even though the
 * daemon is up. Detect that and re-exec the whole driver under `sg docker`
 * so the rest of the run inherits the docker group without a re-login.
 */
function maybeReexecUnderSg(): void {
  if (process.env.NANOCLAW_REEXEC_SG === '1') return;
  if (process.platform !== 'linux') return;
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (info.status === 0) return;
  const err = `${info.stderr ?? ''}\n${info.stdout ?? ''}`;
  if (!/permission denied/i.test(err)) return;
  if (spawnSync('which', ['sg'], { stdio: 'ignore' }).status !== 0) return;

  p.log.warn('Docker socket not accessible in current group — re-executing under `sg docker`.');
  const res = spawnSync('sg', ['docker', '-c', 'pnpm run setup:auto'], {
    stdio: 'inherit',
    env: { ...process.env, NANOCLAW_REEXEC_SG: '1' },
  });
  process.exit(res.status ?? 1);
}

// ─── intro + progression-log init ──────────────────────────────────────

function printIntro(): void {
  const isReexec = process.env.NANOCLAW_REEXEC_SG === '1';
  const wordmark = `${k.bold('Nano')}${brandBold('Claw')}`;

  if (isReexec) {
    p.intro(`${brandChip(' setup:auto ')}  ${wordmark}  ${k.dim('· resuming under docker group')}`);
    return;
  }

  console.log();
  console.log(`  ${wordmark}`);
  console.log(`  ${k.dim('end-to-end scripted setup of your personal assistant')}`);
  p.intro(`${brandChip(' setup:auto ')}`);
}

/**
 * Bootstrap (nanoclaw.sh) normally initializes logs/setup.log and writes
 * the bootstrap entry before we even boot. If someone runs `pnpm run
 * setup:auto` directly, start a fresh progression log here so we don't
 * append to a stale one from a previous run.
 */
function initProgressionLog(): void {
  if (process.env.NANOCLAW_BOOTSTRAPPED === '1') return;
  let commit = '';
  try {
    commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // git not available or not a repo — skip
  }
  let branch = '';
  try {
    branch = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // skip
  }
  setupLog.reset({
    invocation: 'setup:auto (standalone)',
    user: process.env.USER ?? 'unknown',
    cwd: process.cwd(),
    branch: branch || 'unknown',
    commit: commit || 'unknown',
  });
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  p.cancel('Setup aborted.');
  process.exit(1);
});
