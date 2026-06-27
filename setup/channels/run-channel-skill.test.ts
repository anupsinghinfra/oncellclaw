import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runChannelSkill } from './run-channel-skill.js';
import { normalizeName } from '../../src/modules/agent-to-agent/db/agent-destinations.js';

// Drives the real add-slack skill through the adapter with every side effect
// injected (no real ncl/git/clack): confirms it ensures the wire-target group
// for the display-name-derived folder, then applies the skill with that folder
// pre-supplied so the wiring targets it.
describe('runChannelSkill adapter', () => {
  it('ensures the group, then applies the skill with agent_folder pre-supplied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const cmds: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.includes('conversations.open')) return 'D0SLACK\n';
    };

    await runChannelSkill('slack', 'Bob Smith', {
      projectRoot: root,
      exec,
      resolveRemote: () => 'origin',
      // the secrets a human would paste; agent_folder is supplied by the adapter
      inputs: { bot_token: 'xoxb-x', signing_secret: 's', slack_user_id: 'U1' },
    });

    const folder = `dm-with-${normalizeName('Bob Smith')}`;
    expect(cmds).toContain(`ncl groups create --folder '${folder}' --name 'Bob Smith'`); // wire-target ensured
    expect(cmds.some((c) => c.startsWith('ncl wirings create') && c.includes(`--agent-group ${folder}`))).toBe(true); // wired to it
    expect(cmds.some((c) => c.startsWith('ncl messaging-groups create') && c.includes('--channel-type slack'))).toBe(true);
  });
});
