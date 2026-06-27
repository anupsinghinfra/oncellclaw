import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSkill, hostExec, type RunSkillOptions } from './skill-driver.js';
import { fullyApplied, type Prompter } from '../../scripts/skill-apply.js';

// A small SKILL.md exercising the three things the driver wires: an operator
// block (relayed via tell), a secret prompt (asked via ask), and a wire run
// (executed via exec) consuming the captured input.
const SKILL = `# driver demo

## Set up
Tell the user:
\`\`\`nc:operator
Go create the app and copy the token.
\`\`\`
\`\`\`nc:prompt token secret
Paste the token.
\`\`\`

## Wire
\`\`\`nc:run effect:wire
ncl wire --token {{token}}
\`\`\`
`;

function scratch(): { root: string; skill: string } {
  const root = mkdtempSync(join(tmpdir(), 'driver-'));
  const skill = mkdtempSync(join(tmpdir(), 'driver-skill-'));
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(skill, 'SKILL.md'), SKILL);
  return { root, skill };
}

describe('thin skill driver', () => {
  it('asks prompts, relays operator blocks, and execs wiring — with an injected prompter', async () => {
    const { root, skill } = scratch();
    const asked: string[] = [];
    const told: string[] = [];
    const ran: string[] = [];
    const prompter: Prompter = {
      async ask(name) {
        asked.push(name);
        return 'T0KEN';
      },
      tell: (t) => void told.push(t),
    };
    const opts: RunSkillOptions = { projectRoot: root, prompter, exec: (c) => void ran.push(c) };
    const res = await runSkill(skill, opts);

    expect(asked).toEqual(['token']); // the prompt was driven through ask
    expect(told).toEqual(['Go create the app and copy the token.']); // operator relayed through tell
    expect(ran).toContain('ncl wire --token T0KEN'); // wiring executed with the answer substituted in
    expect(res.operatorMessages).toEqual(['Go create the app and copy the token.']);
  });

  it('runs fully from inputs — no prompter touched', async () => {
    const { root, skill } = scratch();
    const ran: string[] = [];
    const res = await runSkill(skill, { projectRoot: root, inputs: { token: 'FROM-INPUTS' }, exec: (c) => void ran.push(c) });
    expect(fullyApplied(res)).toBe(true);
    expect(ran).toContain('ncl wire --token FROM-INPUTS');
  });

  it('hostExec puts the project bin/ on PATH so a bare command resolves to it', () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-bin-'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/greet'), '#!/usr/bin/env bash\necho hi-from-bin\n');
    chmodSync(join(root, 'bin/greet'), 0o755);
    const out = hostExec(root)('greet'); // bare name, not ./bin/greet
    expect(String(out).trim()).toBe('hi-from-bin');
  });

  it('hostExec returns stdout so a capture run can bind it', () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-cap-'));
    expect(String(hostExec(root)('echo D0CHANNEL')).trim()).toBe('D0CHANNEL');
  });

  function reuseScratch(): { root: string; skill: string } {
    const root = mkdtempSync(join(tmpdir(), 'reuse-'));
    const skill = mkdtempSync(join(tmpdir(), 'reuse-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(root, '.env'), 'SLACK_BOT_TOKEN=xoxb-existing-token\n');
    // a skill whose env-set maps bot_token → SLACK_BOT_TOKEN (the reuse linkage)
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# reuse demo\n\n```nc:prompt bot_token secret\nPaste the token.\n```\n```nc:env-set\nSLACK_BOT_TOKEN={{bot_token}}\n```\n```nc:run effect:wire\nuse {{bot_token}}\n```\n',
    );
    return { root, skill };
  }

  it('reuse:true offers an existing .env credential and skips the prompt when accepted', async () => {
    const { root, skill } = reuseScratch();
    const asked: string[] = [];
    const cmds: string[] = [];
    const prompter: Prompter = {
      async ask(n) {
        asked.push(n);
        return 'NEWLY-PASTED';
      },
      async confirm() {
        return true; // yes, reuse the existing value
      },
    };
    await runSkill(skill, { projectRoot: root, prompter, reuse: true, exec: (c) => void cmds.push(c) });
    expect(asked).not.toContain('bot_token'); // reused from .env → never prompted
    expect(cmds).toContain('use xoxb-existing-token'); // the reused value flowed downstream
  });

  it('reuse: declining keeps the prompt', async () => {
    const { root, skill } = reuseScratch();
    const asked: string[] = [];
    const cmds: string[] = [];
    const prompter: Prompter = {
      async ask(n) {
        asked.push(n);
        return 'NEWLY-PASTED';
      },
      async confirm() {
        return false; // no, ask me
      },
    };
    await runSkill(skill, { projectRoot: root, prompter, reuse: true, exec: (c) => void cmds.push(c) });
    expect(asked).toContain('bot_token'); // declined → prompted
    expect(cmds).toContain('use NEWLY-PASTED');
  });
});
