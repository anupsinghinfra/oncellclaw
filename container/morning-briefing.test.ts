/**
 * Morning briefing skill — the flagship scheduling + integrations + memory
 * template.
 *
 * Structural, like oncell-integrations.test.ts: skill content is prose the
 * agent follows, so these tests pin the load-bearing strings — the
 * scheduled-task creation path, the exact proxy endpoints, the one-door
 * send_message delivery rule, and every graceful-degradation branch. A
 * rewrite that drops any of them goes red here.
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect } from 'vitest';

const SKILL_PATH = path.join(process.cwd(), 'container', 'skills', 'morning-briefing', 'SKILL.md');

describe('morning-briefing skill', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf-8');

  it('has valid frontmatter that the /web/status skill catalog can render', () => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1];
    expect(frontmatter).toBeDefined();
    const meta = parseYaml(frontmatter!) as { name?: string; description?: string };
    expect(meta.name).toBe('morning-briefing');
    // The description is the trigger surface — it must name the routine.
    expect(meta.description).toMatch(/morning briefing/i);
    expect(meta.description).toMatch(/daily digest/i);
  });

  it('creates the briefing as a scheduled task via ncl', () => {
    expect(skill).toContain('ncl tasks create');
    expect(skill).toContain('--recurrence');
    // Cron semantics: install timezone, morning default.
    expect(skill).toContain('install timezone');
    expect(skill).toContain('0 8 * * *');
  });

  it('codes against the oncell-integrations proxy contract', () => {
    expect(skill).toContain('Bearer $ONCELL_API_KEY');
    // Provider list for the setup-time connected check.
    expect(skill).toContain('/api/v1/integrations');
    // Gmail unread + Calendar today's events through the generic proxy.
    expect(skill).toContain('/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages');
    expect(skill).toContain('is:unread');
    expect(skill).toContain('/api/v1/integrations/google-calendar/proxy/calendar/v3/calendars/primary/events');
    expect(skill).toContain('singleEvents=true');
  });

  it('composes all three sections: email, calendar, flagged-yesterday memory', () => {
    expect(skill).toMatch(/Unread email/i);
    expect(skill).toMatch(/Today's calendar/i);
    expect(skill).toMatch(/Flagged yesterday/i);
    // The memory section reads the agent's own memory, not an integration.
    expect(skill).toContain('memory/index.md');
  });

  it('delivers through send_message only (task-session one-door rule)', () => {
    expect(skill).toContain('send_message');
    expect(skill).toMatch(/task sessions deliver \*\*only\*\* through/);
  });

  it('degrades gracefully on every failure branch', () => {
    // Unconnected provider: skip + the canonical dashboard connect pointer.
    expect(skill).toContain('not_connected');
    expect(skill).toContain('https://oncell.ai/dashboard/integrations');
    expect(skill).toContain('Connect {Provider} on your OnCell dashboard → Integrations');
    // Transient proxy failure: skip the section, never fail the run.
    expect(skill).toMatch(/never let one source fail the whole briefing/i);
    // No integrations at all: memory-only briefing.
    expect(skill).toContain('`ONCELL_API_KEY` missing');
    expect(skill).toContain('memory-only briefing');
    // Empty morning still sends — the user must know the briefing ran.
    expect(skill).toMatch(/still send/i);
    // Setup is never blocked on connecting providers.
    expect(skill).toMatch(/not\*\* block setup/);
  });

  it('inherits the integrations credential rules (no OAuth, no key requests)', () => {
    expect(skill).toMatch(/never ask the user for API keys/i);
    expect(skill).toMatch(/browser OAuth/);
    // Consistent with oncell-integrations: no OneCLI dashboard mentions.
    expect(skill).not.toContain('OneCLI');
  });
});
