/**
 * Inbox Sentinel — the always-on email chief of staff.
 *
 * Structural, like oncell-integrations.test.ts: skill content is prose the
 * agent follows, so these tests pin the load-bearing strings — the watcher
 * schedule, both mail providers' proxy endpoints, the todo.md format, the
 * dedupe state-file convention, the approval-or-standing-grant hard rule,
 * the noise rule, and the per-provider degradation copy. A rewrite that
 * drops any of them goes red here.
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect } from 'vitest';

const SKILL_DIR = path.join(process.cwd(), 'container', 'skills', 'inbox-sentinel');
const BRIEFING_PATH = path.join(process.cwd(), 'container', 'skills', 'morning-briefing', 'SKILL.md');

describe('inbox-sentinel skill', () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
  const instructions = fs.readFileSync(path.join(SKILL_DIR, 'instructions.md'), 'utf-8');

  it('ships both the skill and its CLAUDE.md fragment', () => {
    // instructions.md existing is what wires it into composeGroupClaudeMd —
    // the same default-set wiring oncell-integrations uses.
    expect(instructions.length).toBeGreaterThan(0);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1];
    const meta = parseYaml(frontmatter!) as { name?: string; description?: string };
    expect(meta.name).toBe('inbox-sentinel');
    expect(meta.description).toMatch(/chief of staff/i);
    expect(meta.description).toMatch(/what's on my plate/i);
  });

  it('watches on a recurring scheduled task with an adjustable default cadence', () => {
    expect(skill).toContain('ncl tasks create');
    expect(skill).toContain('*/20 * * * *');
    expect(skill).toMatch(/default every 20 minutes/i);
    expect(skill).toContain('durable-wake bridge');
  });

  it('codes against both mail providers through the integrations proxy', () => {
    expect(skill).toContain('Bearer $ONCELL_API_KEY');
    expect(skill).toContain('/api/v1/integrations');
    // Gmail: list unread, per-id get, send, modify.
    expect(skill).toContain('/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages?q=is:unread');
    expect(skill).toContain('format=metadata');
    expect(skill).toContain('/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages/send');
    expect(skill).toContain('/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages/{id}/modify');
    // Outlook via Microsoft Graph: unread filter + sendMail.
    expect(skill).toContain('/api/v1/integrations/outlook/proxy/me/messages');
    expect(skill).toContain('isRead%20eq%20false');
    expect(skill).toContain('/api/v1/integrations/outlook/proxy/me/sendMail');
    // Calendar: conflict reads + event insert.
    expect(skill).toContain('/api/v1/integrations/google-calendar/proxy/calendar/v3/calendars/primary/events');
    expect(skill).toMatch(/-X POST[\s\S]*calendars\/primary\/events/);
  });

  it('documents the todo.md format: three sections, checkboxes, source refs, urgency', () => {
    expect(skill).toContain('## Inbox-derived');
    expect(skill).toContain('## User-added');
    expect(skill).toContain('## Waiting-on');
    expect(skill).toContain('- [ ]');
    expect(skill).toContain('(gmail:<message-id>)');
    expect(skill).toContain('(outlook:<message-id>)');
    expect(skill).toMatch(/`urgent` \/ `today` \/ `this-week`/);
    expect(skill).toMatch(/single durable todo list/i);
  });

  it('dedupes by message id in the documented state file', () => {
    expect(skill).toContain('inbox-sentinel.state.json');
    expect(skill).toContain('seenMessageIds');
    expect(skill).toMatch(/never re-triaged/i);
  });

  it('reminds only past thresholds, batched, quiet-hours aware', () => {
    expect(skill).toMatch(/\*\*only\*\* when something crosses an action\s+threshold/i);
    expect(skill).toMatch(/never more than\s+one unprompted message per cycle/i);
    expect(skill).toContain('send_message');
    expect(skill).toMatch(/quiet hours.*ask the user once.*store the answer\s+in memory/is);
  });

  it('hard rule: never act without approval or a standing grant', () => {
    expect(skill).toMatch(/never act without approval or a standing grant/i);
    expect(skill).toMatch(/standing grant/);
    expect(skill).toMatch(/recorded verbatim, with its date, in\s+memory/);
    expect(skill).toMatch(/Reads never need\s+approval/);
    expect(instructions).toMatch(/Never send email or write to a calendar without explicit approval/);
  });

  it('kills noise: non-actionable mail never surfaces', () => {
    expect(skill).toMatch(/Non-actionable mail[\s\S]*never surfaces/);
    for (const doc of [skill, instructions]) {
      expect(doc).toMatch(/newsletters,\s+receipts/);
    }
  });

  it('degrades per provider with the canonical connect copy, nudged once', () => {
    expect(skill).toContain('not_connected');
    expect(skill).toContain('Connect {Provider} on your OnCell dashboard → Integrations');
    expect(skill).toContain('https://oncell.ai/dashboard/integrations');
    expect(skill).toContain('connectNudged');
    expect(skill).toMatch(/once, not every cycle/i);
    // Consistent with oncell-integrations: no OneCLI mentions anywhere.
    expect(skill).not.toContain('OneCLI');
    expect(instructions).not.toContain('OneCLI');
  });

  it('answers on-demand from todo.md, never by re-fetching', () => {
    expect(skill).toMatch(/what's on my plate/);
    expect(skill).toMatch(/do \*\*not\*\* re-fetch mail/i);
    expect(instructions).toMatch(/never re-fetch mail to answer/);
  });

  it('cross-references morning-briefing as its daily-digest preset, both ways', () => {
    expect(skill).toMatch(/morning-briefing[\s\S]{0,80}daily-digest preset/);
    const briefing = fs.readFileSync(BRIEFING_PATH, 'utf-8');
    expect(briefing).toContain('inbox-sentinel');
    expect(briefing).toMatch(/daily-digest preset/);
  });
});
