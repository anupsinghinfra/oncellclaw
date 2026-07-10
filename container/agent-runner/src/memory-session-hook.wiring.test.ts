import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Claude memory hook wiring', () => {
  const providerSource = fs.readFileSync(path.join(import.meta.dir, 'providers', 'claude.ts'), 'utf-8');
  const groupInitSource = fs.readFileSync(path.join(import.meta.dir, '..', '..', '..', 'src', 'group-init.ts'), 'utf-8');

  it('registers the command hook in Claude settings and advertises the capability', () => {
    expect(groupInitSource).toContain("const MEMORY_SESSION_START_MATCHER = 'startup|clear|compact'");
    expect(groupInitSource).toContain("const MEMORY_SESSION_START_COMMAND = 'bun /app/src/memory-hook.ts'");
    expect(providerSource).toContain('readonly providesMemorySessionHook = true');
    expect(providerSource).not.toContain('SessionStart: [{ matcher:');
  });
});
