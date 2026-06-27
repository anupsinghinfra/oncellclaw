/**
 * Generic channel onboarding for setup:auto — the replacement for the bespoke
 * per-channel `run<Channel>Channel` flows.
 *
 * Split of responsibilities (Option A):
 *   - The channel's SKILL.md owns the channel-specific part: install the adapter,
 *     collect credentials, and resolve the wire inputs `owner_handle` +
 *     `platform_id` (e.g. Slack `conversations.open`). The engine surfaces those
 *     resolved values in `ApplyResult.vars`.
 *   - This flow owns the shared part: the operator's agent name + role (the
 *     polish), and the wire itself — `scripts/init-first-agent.ts`, which creates
 *     the agent group, grants the owner role (+ cli_scope=global), creates the
 *     messaging group + wiring, and sends the `/welcome` system instruction.
 *
 * So the wire lives in exactly one place (init-first-agent) and is never
 * duplicated across channel skills.
 */
import * as p from '@clack/prompts';

import { fullyApplied } from '../../scripts/skill-apply.js';
import { type ChannelFlowResult } from '../lib/back-nav.js';
import { askOperatorRole, type OperatorRole } from '../lib/role-prompt.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { runSkill, type RunSkillOptions } from '../lib/skill-driver.js';

const DEFAULT_AGENT_NAME = 'Nano';

interface WireArgs {
  channel: string;
  userId: string;
  platformId: string;
  displayName: string;
  agentName: string;
  role: OperatorRole;
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) return preset;
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your assistant be called?',
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  return (answer as string).trim() || DEFAULT_AGENT_NAME;
}

/** The shared wire: init-first-agent (group + owner role + cli_scope + wiring + /welcome). */
async function initFirstAgent(args: WireArgs): Promise<boolean> {
  const res = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', args.channel,
      '--user-id', args.userId,
      '--platform-id', args.platformId,
      '--display-name', args.displayName,
      '--agent-name', args.agentName,
      '--role', args.role,
    ],
    { running: `Wiring ${args.agentName} to your ${args.channel} DMs…`, done: 'Agent wired.' },
    { extraFields: { CHANNEL: args.channel, AGENT_NAME: args.agentName, PLATFORM_ID: args.platformId } },
  );
  return res.ok;
}

export interface ChannelSkillOverrides extends Partial<RunSkillOptions> {
  agentName?: string;
  role?: OperatorRole;
  /** The shared wire; defaults to init-first-agent. Injectable for tests. */
  wire?: (args: WireArgs) => Promise<boolean> | boolean;
}

export async function runChannelSkill(
  channel: string,
  displayName: string,
  overrides: ChannelSkillOverrides = {},
): Promise<ChannelFlowResult> {
  const projectRoot = overrides.projectRoot ?? process.cwd();
  const agentName = overrides.agentName ?? (await resolveAgentName());
  const role = overrides.role ?? (await askOperatorRole(channel));

  // Channel-specific: install adapter, collect credentials, resolve the wire
  // inputs. The whole channel-specific procedure lives in the SKILL.md.
  const res = await runSkill(`.claude/skills/add-${channel}`, {
    projectRoot,
    exec: overrides.exec,
    prompter: overrides.prompter,
    resolveRemote: overrides.resolveRemote,
    inputs: overrides.inputs,
    skipEffects: overrides.skipEffects,
    reuse: overrides.reuse ?? true, // offer to reuse credentials already in .env
  });
  if (!fullyApplied(res)) {
    if (res.deferred.length) p.log.warn(`Still needs: ${res.deferred.join(', ')}`);
    for (const t of res.agentTasks) p.log.warn(`Needs an agent (${t.kind}): ${t.reason}`);
    await fail(`${channel}-install`, `Couldn't finish setting up ${channel}.`, 'See logs/setup-steps/ for details, then retry setup.');
  }

  // Identity confirmation captured by the skill (e.g. add-slack's auth.test).
  if (res.vars.connected_as) p.log.success(`Connected to ${channel} as ${res.vars.connected_as}.`);

  const ownerHandle = res.vars.owner_handle;
  const platformId = res.vars.platform_id;
  if (!ownerHandle || !platformId) {
    await fail(
      `${channel}-resolve`,
      `Couldn't resolve your ${channel} address.`,
      'The skill did not produce owner_handle + platform_id.',
    );
  }

  // Shared wire — the same procedure for every channel.
  const wire = overrides.wire ?? initFirstAgent;
  const ok = await wire({ channel, userId: `${channel}:${ownerHandle}`, platformId, displayName, agentName, role });
  if (!ok) {
    await fail('init-first-agent', `Couldn't finish connecting ${agentName}.`, 'You can retry later with `/init-first-agent`.');
  }
}
