/**
 * OnCell-native integrations — the DEFAULT external-service path.
 *
 * Pins the skill files against the api-server contract being built in
 * parallel (list → [{provider,connected}], generic proxy, 409
 * not_connected + connectUrl) and the exact user-facing connect copy, and
 * pins the demotion of the legacy onecli-gateway skill. Structural: skill
 * content is prose the agent follows, so the test guards the load-bearing
 * strings.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const SKILL_DIR = path.join(process.cwd(), 'container', 'skills', 'oncell-integrations');
const LEGACY_DIR = path.join(process.cwd(), 'container', 'skills', 'onecli-gateway');

describe('oncell-integrations skill', () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
  const instructions = fs.readFileSync(path.join(SKILL_DIR, 'instructions.md'), 'utf-8');

  it('ships both the skill and its CLAUDE.md fragment', () => {
    expect(skill).toContain('name: oncell-integrations');
    // instructions.md existing is what wires it into composeGroupClaudeMd.
    expect(instructions.length).toBeGreaterThan(0);
  });

  it('codes against the api-server contract', () => {
    for (const doc of [skill, instructions]) {
      expect(doc).toContain('/api/v1/integrations');
      expect(doc).toContain('Bearer $ONCELL_API_KEY');
      expect(doc).toContain('not_connected');
    }
    // Generic proxy shape + the three v1 providers.
    expect(skill).toContain('/api/v1/integrations/gmail/proxy/');
    expect(skill).toContain('/api/v1/integrations/google-calendar/proxy/');
    expect(skill).toContain('/api/v1/integrations/github/proxy/');
    expect(skill).toContain('https://oncell.ai/dashboard/integrations');
  });

  it('carries the exact connect copy and bans the OneCLI dashboard', () => {
    expect(skill).toContain('Connect {Provider} on your OnCell dashboard → Integrations');
    expect(skill).toContain("then tell me and I'll retry");
    for (const doc of [skill, instructions]) {
      // The only OneCLI mention allowed is the explicit ban itself.
      const mentions = doc.match(/OneCLI/g) ?? [];
      const bans = doc.match(/[Nn]ever mention a "OneCLI dashboard"/g) ?? [];
      expect(mentions.length).toBe(bans.length);
    }
  });
});

describe('onecli-gateway skill is demoted to legacy', () => {
  it('both files scope themselves to installs with an actual gateway', () => {
    const skill = fs.readFileSync(path.join(LEGACY_DIR, 'SKILL.md'), 'utf-8');
    const instructions = fs.readFileSync(path.join(LEGACY_DIR, 'instructions.md'), 'utf-8');
    expect(skill).toContain('LEGACY');
    expect(skill).toContain('oncell-integrations');
    expect(instructions).toContain('Legacy path');
    expect(instructions).toContain('oncell-integrations');
  });
});
