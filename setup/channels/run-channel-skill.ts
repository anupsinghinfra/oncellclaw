/**
 * Generic channel onboarding for setup:auto — the replacement for the bespoke
 * per-channel `run<Channel>Channel` flows. The entire connect+wire procedure
 * lives in the channel's SKILL.md (operator walkthroughs, credential prompts,
 * restart, ncl wiring), so this just:
 *
 *   1. ensures the wire-target agent group exists (the SKILL.md wires to it),
 *   2. runs the SKILL.md through the thin driver,
 *   3. reports the outcome.
 *
 * The agent group is created over `ncl` (the running service owns the DB; the
 * setup process has none), idempotent on the folder, so adding a second DM
 * channel reuses the same `dm-with-<name>` group.
 */
import * as p from '@clack/prompts';

import { fullyApplied } from '../../scripts/skill-apply.js';
import { normalizeName } from '../../src/modules/agent-to-agent/db/agent-destinations.js';
import { type ChannelFlowResult } from '../lib/back-nav.js';
import { hostExec, runSkill, type RunSkillOptions } from '../lib/skill-driver.js';

/** Wrap a value as a single-quoted shell argument. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runChannelSkill(
  channel: string,
  displayName: string,
  overrides: Partial<RunSkillOptions> = {},
): Promise<ChannelFlowResult> {
  const projectRoot = overrides.projectRoot ?? process.cwd();
  const exec = overrides.exec ?? hostExec(projectRoot);
  const folder = `dm-with-${normalizeName(displayName)}`;

  // Ensure the wire-target group (+ its container config) exists. Idempotent.
  exec(`ncl groups create --folder ${shq(folder)} --name ${shq(displayName)}`);

  const res = await runSkill(`.claude/skills/add-${channel}`, {
    projectRoot,
    inputs: { agent_folder: folder, ...overrides.inputs },
    exec,
    prompter: overrides.prompter,
    resolveRemote: overrides.resolveRemote,
    skipEffects: overrides.skipEffects,
  });

  if (fullyApplied(res)) {
    p.log.success(`${channel} connected.`);
  } else {
    if (res.deferred.length) p.log.warn(`Still needs: ${res.deferred.join(', ')}`);
    for (const t of res.agentTasks) p.log.warn(`Needs an agent (${t.kind}): ${t.reason}`);
    p.log.warn(`${channel} setup didn't fully complete — see above.`);
  }
}
