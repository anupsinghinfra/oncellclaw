import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const skill = fs.readFileSync(path.resolve('.claude/skills/migrate-memory/SKILL.md'), 'utf-8');

describe('shared-memory migration contract', () => {
  it('inventories every legacy memory surface disabled or replaced by the cutover', () => {
    expect(skill).toContain('### Legacy `CLAUDE.md`');
    expect(skill).toContain('.claude-shared/projects/*/memory/');
    expect(skill).toContain('### `CLAUDE.local.md`');
    expect(skill).toContain('### `.seed.md`');
  });

  it('pauses scheduled wakes for the maintenance window and restores only recorded tasks', () => {
    expect(skill).toContain('ncl tasks pause <series-id> --group <group-id>');
    expect(skill).toContain('ncl tasks resume <series-id> --group <group-id>');
    expect(skill).toMatch(/Do not resume tasks that\s+were already paused/);
  });
});
