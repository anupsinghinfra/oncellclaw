import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-claude-md-compose-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-claude-md-compose-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function seed(ag: AgentGroup): void {
  createAgentGroup(ag);
  ensureContainerConfig(ag.id);
}

function writePersona(folder: string, text: string): void {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PERSONA_PREPEND_FILE), text);
}

function importsOf(folder: string): string[] {
  const md = fs.readFileSync(path.join(GROUPS_DIR, folder, 'CLAUDE.md'), 'utf-8');
  return md.split('\n').filter((line) => line.startsWith('@'));
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('composeGroupClaudeMd persona prepend', () => {
  it('imports the persona fragment FIRST, before the shared base', () => {
    const ag = group('ag-persona', 'persona-group');
    seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-fragments/persona.md');
    expect(imports[1]).toBe('@./.claude-shared.md');
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'), 'utf-8')).toBe(
      'You are an SDR agent.',
    );
  });

  it('keeps the persona across a second compose (not pruned)', () => {
    const ag = group('ag-persona-2', 'persona-group-2');
    seed(ag);
    writePersona(ag.folder, 'persona body');

    composeGroupClaudeMd(ag);
    composeGroupClaudeMd(ag);

    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(true);
    expect(importsOf(ag.folder)[0]).toBe('@./.claude-fragments/persona.md');
  });

  it('is inert when no persona file is present (non-template groups)', () => {
    const ag = group('ag-no-persona', 'no-persona-group');
    seed(ag);

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-shared.md');
    expect(imports).not.toContain('@./.claude-fragments/persona.md');
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(false);
  });
});

describe('composeGroupClaudeMd scheduling instructions (ncl tasks reach-in)', () => {
  // Red-on-delete guard for the `scheduling`/`cli` exclusion at the
  // module-fragment loop: the agent is taught `ncl tasks` iff it has ncl.
  it('imports module-scheduling.md at the default cli_scope', () => {
    const ag = group('ag-sched', 'sched-group');
    seed(ag);

    composeGroupClaudeMd(ag);

    expect(importsOf(ag.folder)).toContain('@./.claude-fragments/module-scheduling.md');
  });

  it('excludes module-scheduling.md (and module-cli.md) when cli_scope is disabled', () => {
    const ag = group('ag-sched-off', 'sched-group-off');
    seed(ag);
    updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports).not.toContain('@./.claude-fragments/module-scheduling.md');
    expect(imports).not.toContain('@./.claude-fragments/module-cli.md');
  });
});

describe('gateway posture — onecli-gateway fragment', () => {
  it('raw posture: the legacy vault fragment is DROPPED and oncell-integrations carries the guidance', async () => {
    const { _setOneCliConfiguredForTesting } = await import('./cell-gateway.js');
    _setOneCliConfiguredForTesting(false);
    try {
      const ag = group('ag-raw', 'raw-posture');
      seed(ag);
      composeGroupClaudeMd(ag);

      const fragDir = path.join(GROUPS_DIR, 'raw-posture', '.claude-fragments');
      // No OneCLI vault instructions anywhere near the agent… (lstat: the
      // fragment would be a dangling symlink, invisible to existsSync)
      expect(() => fs.lstatSync(path.join(fragDir, 'skill-onecli-gateway.md'))).toThrow();
      expect(importsOf('raw-posture')).not.toContain('@./.claude-fragments/skill-onecli-gateway.md');
      // …the OnCell integrations skill is the default path instead. The
      // fragment is a symlink to a container path (dangling on host), so
      // lstat/readlink, never existsSync (which follows the link).
      const integrationsFrag = path.join(fragDir, 'skill-oncell-integrations.md');
      expect(fs.lstatSync(integrationsFrag).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(integrationsFrag)).toBe('/app/skills/oncell-integrations/instructions.md');
      expect(importsOf('raw-posture')).toContain('@./.claude-fragments/skill-oncell-integrations.md');
    } finally {
      _setOneCliConfiguredForTesting(undefined);
    }
  });

  it('configured posture: the real vault instructions symlink is kept', async () => {
    const { _setOneCliConfiguredForTesting } = await import('./cell-gateway.js');
    _setOneCliConfiguredForTesting(true);
    try {
      const ag = group('ag-vault', 'vault-posture');
      seed(ag);
      composeGroupClaudeMd(ag);

      const fragPath = path.join(GROUPS_DIR, 'vault-posture', '.claude-fragments', 'skill-onecli-gateway.md');
      expect(fs.lstatSync(fragPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(fragPath)).toBe('/app/skills/onecli-gateway/instructions.md');
    } finally {
      _setOneCliConfiguredForTesting(undefined);
    }
  });

  it('a posture flip swaps the fragment in place (reconcile pass)', async () => {
    const { _setOneCliConfiguredForTesting } = await import('./cell-gateway.js');
    try {
      const ag = group('ag-flip', 'flip-posture');
      seed(ag);
      _setOneCliConfiguredForTesting(false);
      composeGroupClaudeMd(ag);
      const fragPath = path.join(GROUPS_DIR, 'flip-posture', '.claude-fragments', 'skill-onecli-gateway.md');
      expect(() => fs.lstatSync(fragPath)).toThrow();

      _setOneCliConfiguredForTesting(true);
      composeGroupClaudeMd(ag);
      expect(fs.lstatSync(fragPath).isSymbolicLink()).toBe(true);
    } finally {
      _setOneCliConfiguredForTesting(undefined);
    }
  });
});
