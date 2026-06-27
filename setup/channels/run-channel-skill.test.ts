import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runChannelSkill } from './run-channel-skill.js';

// Drives the real add-slack skill through the adapter with every side effect
// injected (no real ncl/git/clack/init-first-agent): confirms it runs the skill
// (install + creds + resolve), reads the resolved owner_handle + platform_id from
// the result, and hands them to the shared wire with a composed user-id.
describe('runChannelSkill adapter (Option A)', () => {
  it('resolves via the skill, then wires through init-first-agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const cmds: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.includes('auth.test')) return '@bot in Acme\n'; // identity capture
      // the resolve run: conversations.open piped through jq → "slack:<channel>"
      if (c.includes('conversations.open')) return 'slack:D0SLACK\n';
    };
    const wired: Array<Record<string, unknown>> = [];

    await runChannelSkill('slack', 'Bob Smith', {
      projectRoot: root,
      exec,
      resolveRemote: () => 'origin',
      agentName: 'Nano',
      role: 'owner',
      // the secrets + handle a human would supply; the skill resolves platform_id
      inputs: { bot_token: 'xoxb-x', signing_secret: 's', owner_handle: 'U1' },
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    // the channel-specific resolve ran
    expect(cmds.some((c) => c.includes('auth.test'))).toBe(true);
    expect(cmds.some((c) => c.includes('conversations.open'))).toBe(true);
    // ...and the shared wire got the composed user-id + resolved platform_id
    expect(wired).toHaveLength(1);
    expect(wired[0]).toMatchObject({
      channel: 'slack',
      userId: 'slack:U1', // channel + owner_handle
      platformId: 'slack:D0SLACK', // captured from conversations.open
      displayName: 'Bob Smith',
      agentName: 'Nano',
      role: 'owner',
    });
    // the adapter no longer emits any ncl wiring itself — that's init-first-agent's job
    expect(cmds.some((c) => c.startsWith('ncl '))).toBe(false);
  });
});
