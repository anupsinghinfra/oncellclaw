/**
 * The thin generic driver: render a SKILL.md's human I/O through clack and run
 * the directive engine. The entire connect+wire procedure now lives in the
 * SKILL.md — operator walkthroughs (`nc:operator`), credential prompts
 * (`nc:prompt`), the service restart (`nc:run effect:restart`), and the wiring
 * (`nc:run effect:wire`, `ncl …`). So the driver is just: render the operator
 * blocks, ask the prompts, run the engine in document order. It replaces the
 * bespoke per-channel `setup/channels/<channel>.ts` flows with one function.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as p from '@clack/prompts';

import { applySkill, fullyApplied, type ApplyResult, type Prompter } from '../../scripts/skill-apply.js';
import { parseDirectives } from '../../scripts/skill-directives.js';

/**
 * Clack-backed human I/O: `ask` collects an `nc:prompt` (password for secrets,
 * text otherwise; a cancel defers), `tell` renders an `nc:operator` block as a
 * note. The prompt that follows an operator block is the natural barrier — the
 * user can't paste a token before they've done the steps.
 */
export function clackPrompter(): Prompter {
  return {
    async ask(_varName, question, secret, validate) {
      const re = validate ? new RegExp(validate) : undefined;
      const check = re
        ? (v: string | undefined) => (re.test((v ?? '').trim()) ? undefined : `That doesn't match the expected format.`)
        : undefined;
      const ans = secret
        ? await p.password({ message: question, validate: check })
        : await p.text({ message: question, validate: check });
      if (p.isCancel(ans)) return undefined; // cancelled ⇒ defer
      const v = String(ans).trim();
      return v.length ? v : undefined;
    },
    tell(text) {
      p.note(text, 'Do this');
    },
    async confirm(message) {
      const ans = await p.confirm({ message });
      return ans === true; // cancel ⇒ false
    },
  };
}

/** Mask a credential for display: first 6 + last 4. */
function maskValue(v: string): string {
  return v.length <= 12 ? '••••' : `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/** Parse `KEY=value` lines from a .env file body. */
function parseEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m && m[2].trim()) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Offer to reuse credentials already in `.env` so a re-run doesn't re-prompt for
 * them. The prompt var → ENV_KEY mapping comes from the skill's own `env-set`
 * directives, so this stays generic. Returns the inputs the operator chose to
 * reuse (interactive: each is confirmed via `prompter.confirm`).
 */
async function reuseFromEnv(
  skillDir: string,
  projectRoot: string,
  alreadyHave: Record<string, string>,
  confirm: (message: string) => Promise<boolean>,
): Promise<Record<string, string>> {
  let md: string;
  try {
    md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    return {};
  }
  const varToKey = new Map<string, string>();
  for (const d of parseDirectives(md)) {
    if (d.kind !== 'env-set') continue;
    for (const line of d.body) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/);
      if (m) varToKey.set(m[2], m[1]); // var → ENV_KEY
    }
  }
  let env: Record<string, string> = {};
  try {
    env = parseEnv(readFileSync(join(projectRoot, '.env'), 'utf8'));
  } catch {
    return {};
  }
  const reuse: Record<string, string> = {};
  for (const [v, key] of varToKey) {
    if (v in alreadyHave) continue; // caller already supplied it
    const existing = env[key];
    if (!existing) continue;
    if (await confirm(`Found an existing ${key} (${maskValue(existing)}). Use it?`)) reuse[v] = existing;
  }
  return reuse;
}

/**
 * Host exec for the engine's run directives. Returns stdout so a
 * `run capture:<var>` can bind it. Puts the project's `bin/` on PATH so a bare
 * `ncl …` in a wire directive resolves to `bin/ncl` even when it isn't
 * symlinked onto the operator's PATH.
 */
export function hostExec(projectRoot: string): (cmd: string) => string {
  return (cmd) =>
    execSync(cmd, {
      cwd: projectRoot,
      shell: '/bin/bash',
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(projectRoot, 'bin')}:${process.env.PATH ?? ''}` },
    });
}

/** Fork-aware registry-branch remote (same resolver setup/channels/slack.ts uses). */
function channelsRemote(projectRoot: string): () => string {
  return () =>
    execSync('source setup/lib/channels-remote.sh; resolve_channels_remote', {
      cwd: projectRoot,
      shell: '/bin/bash',
      encoding: 'utf8',
    }).trim();
}

export interface RunSkillOptions {
  projectRoot?: string;
  /** Pre-supplied prompt answers — pass them all for a fully programmatic run. */
  inputs?: Record<string, string>;
  /** Defaults to clack; inject a fake for tests or a relay for a coding agent. */
  prompter?: Prompter;
  /** Defaults to `hostExec`. */
  exec?: (cmd: string) => string | void;
  /** Defaults to the fork-aware channels-branch resolver. */
  resolveRemote?: (branch: string) => string;
  /** Run effects the caller owns (e.g. `['restart']` when it restarts once). */
  skipEffects?: string[];
  /** Offer to reuse credentials already in `.env` instead of re-prompting. */
  reuse?: boolean;
}

/**
 * Run a SKILL.md end-to-end through the directive engine with host-wired I/O.
 * Returns the engine's result; `fullyApplied(res)` tells the caller whether the
 * run completed or left prompts deferred / steps for an agent.
 */
export async function runSkill(skillDir: string, opts: RunSkillOptions = {}): Promise<ApplyResult> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const prompter = opts.prompter ?? clackPrompter();
  let inputs = opts.inputs;
  // Offer to reuse credentials already in .env before the engine prompts for them.
  if (opts.reuse && prompter.confirm) {
    const reused = await reuseFromEnv(skillDir, projectRoot, inputs ?? {}, prompter.confirm.bind(prompter));
    if (Object.keys(reused).length) inputs = { ...inputs, ...reused };
  }
  return applySkill(skillDir, projectRoot, {
    inputs,
    prompter,
    exec: opts.exec ?? hostExec(projectRoot),
    resolveRemote: opts.resolveRemote ?? channelsRemote(projectRoot),
    skipEffects: opts.skipEffects,
  });
}

// CLI: pnpm exec tsx setup/lib/skill-driver.ts <skillDir>   — apply a skill interactively.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const skillDir = process.argv[2];
    if (!skillDir) {
      console.error('usage: pnpm exec tsx setup/lib/skill-driver.ts <skillDir>');
      process.exit(2);
    }
    p.intro(`Applying ${skillDir}`);
    const res = await runSkill(skillDir);
    if (fullyApplied(res)) {
      p.outro('Done — fully applied.');
    } else {
      if (res.deferred.length) p.log.warn(`No value yet for: ${res.deferred.join(', ')}`);
      for (const t of res.agentTasks) p.log.warn(`Needs an agent (${t.kind}): ${t.reason}`);
      p.outro('Applied with gaps — see above.');
    }
  })();
}
