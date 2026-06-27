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

  // Teams' platform_id only exists after the first inbound, so its SKILL.md
  // installs + hands off and runChannelSkill is called with deferWire — it must
  // run the skill but never reach the shared wire.
  it('deferWire (Teams): runs install + handoff, never reaches the shared wire', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-teams-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const cmds: string[] = [];
    const wired: unknown[] = [];

    await runChannelSkill('teams', 'Acme Corp', {
      projectRoot: root,
      exec: (c) => void cmds.push(c),
      resolveRemote: () => 'origin',
      reuse: false,
      deferWire: true,
      // a MultiTenant app, so the SingleTenant-guarded app_tenant_id prompt is skipped
      inputs: {
        public_url: 'https://acme.example',
        app_id: '12345678-1234-1234-1234-123456789abc',
        app_type: 'MultiTenant',
        app_password: 'sekret',
      },
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    // install + manifest ran…
    expect(cmds.some((c) => c.includes('teams-manifest-build'))).toBe(true);
    // …but the shared wire was never reached (no owner_handle/platform_id needed)
    expect(wired).toHaveLength(0);
  });
});
