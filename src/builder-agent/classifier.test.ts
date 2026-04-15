import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  classifyDiff,
  classifyPath,
  isMigrationPath,
  isRunnerOrSkillsPath,
  type ClassifyOptions,
} from './classifier.js';

const OPTS: ClassifyOptions = {
  projectRoot: '/repo',
  dataDir: '/repo/data',
  originatingGroupId: 'grp-abc',
  originatingGroupFolder: 'main',
};

describe('classifyPath', () => {
  it('routes runner edits to the per-group private runner dir', () => {
    const r = classifyPath('container/agent-runner/src/index.ts', OPTS);
    expect(r).not.toBeNull();
    expect(r!.classification).toBe('group');
    expect(r!.target).toBe(
      path.join('/repo/data/v2-sessions/grp-abc/agent-runner-src/index.ts'),
    );
  });

  it('routes nested runner edits correctly', () => {
    const r = classifyPath('container/agent-runner/src/mcp-tools/agents.ts', OPTS);
    expect(r!.classification).toBe('group');
    expect(r!.target).toBe(
      path.join(
        '/repo/data/v2-sessions/grp-abc/agent-runner-src/mcp-tools/agents.ts',
      ),
    );
  });

  it('routes skills edits to the per-group private skills dir', () => {
    const r = classifyPath('container/skills/browser/SKILL.md', OPTS);
    expect(r!.classification).toBe('group');
    expect(r!.target).toBe(
      path.join(
        '/repo/data/v2-sessions/grp-abc/.claude-shared/skills/browser/SKILL.md',
      ),
    );
  });

  it('routes originating group folder edits to their repo path', () => {
    const r = classifyPath('groups/main/CLAUDE.md', OPTS);
    expect(r!.classification).toBe('group');
    expect(r!.target).toBe('/repo/groups/main/CLAUDE.md');
  });

  it('treats other groups as host-level', () => {
    const r = classifyPath('groups/other-group/CLAUDE.md', OPTS);
    expect(r!.classification).toBe('host');
    expect(r!.target).toBe('/repo/groups/other-group/CLAUDE.md');
  });

  it('treats src/ as host-level', () => {
    const r = classifyPath('src/delivery.ts', OPTS);
    expect(r!.classification).toBe('host');
    expect(r!.target).toBe('/repo/src/delivery.ts');
  });

  it('treats root package.json as host-level', () => {
    const r = classifyPath('package.json', OPTS);
    expect(r!.classification).toBe('host');
  });

  it('treats root Dockerfile as host-level', () => {
    const r = classifyPath('Dockerfile', OPTS);
    expect(r!.classification).toBe('host');
  });

  it('treats container/Dockerfile as host-level', () => {
    const r = classifyPath('container/Dockerfile', OPTS);
    expect(r!.classification).toBe('host');
  });

  it('treats docs/ as host-level', () => {
    const r = classifyPath('docs/v2-checklist.md', OPTS);
    expect(r!.classification).toBe('host');
  });

  it('rejects .env and its variants', () => {
    expect(classifyPath('.env', OPTS)).toBeNull();
    expect(classifyPath('.env.local', OPTS)).toBeNull();
    expect(classifyPath('.env.production', OPTS)).toBeNull();
  });

  it('rejects data/ and store/ writes', () => {
    expect(classifyPath('data/something', OPTS)).toBeNull();
    expect(classifyPath('data/v2-sessions/foo/bar', OPTS)).toBeNull();
    expect(classifyPath('store/anything', OPTS)).toBeNull();
  });

  it('rejects absolute and traversal paths', () => {
    expect(classifyPath('/etc/passwd', OPTS)).toBeNull();
    expect(classifyPath('../outside', OPTS)).toBeNull();
    expect(classifyPath('', OPTS)).toBeNull();
  });
});

describe('isRunnerOrSkillsPath', () => {
  it('detects runner paths', () => {
    expect(isRunnerOrSkillsPath('container/agent-runner/src/index.ts')).toBe(true);
  });
  it('detects skills paths', () => {
    expect(isRunnerOrSkillsPath('container/skills/browser/SKILL.md')).toBe(true);
  });
  it('does not match unrelated container paths', () => {
    expect(isRunnerOrSkillsPath('container/Dockerfile')).toBe(false);
    expect(isRunnerOrSkillsPath('container/build.sh')).toBe(false);
  });
  it('does not match groups/ paths', () => {
    expect(isRunnerOrSkillsPath('groups/main/skills/foo.md')).toBe(false);
  });
});

describe('isMigrationPath', () => {
  it('detects migrations', () => {
    expect(isMigrationPath('src/db/migrations/007-new.ts')).toBe(true);
  });
  it('rejects other src paths', () => {
    expect(isMigrationPath('src/db/users.ts')).toBe(false);
  });
});

describe('classifyDiff — overall classification', () => {
  it('is "group" when all changes land in originating group targets', () => {
    const d = classifyDiff(
      ['groups/main/CLAUDE.md', 'container/agent-runner/src/index.ts'],
      OPTS,
    );
    expect(d.overall).toBe('group');
    expect(d.hostPaths).toHaveLength(0);
    expect(d.runnerOrSkillsPaths).toHaveLength(1);
  });

  it('is "host" when only host paths change and none are runner/skills', () => {
    const d = classifyDiff(['src/delivery.ts', 'package.json'], OPTS);
    expect(d.overall).toBe('host');
    expect(d.hostPaths).toHaveLength(2);
    expect(d.runnerOrSkillsPaths).toHaveLength(0);
  });

  it('is "combined" when host AND runner/skills are both changed', () => {
    const d = classifyDiff(
      ['src/delivery.ts', 'container/agent-runner/src/poll-loop.ts'],
      OPTS,
    );
    expect(d.overall).toBe('combined');
    expect(d.hostPaths).toHaveLength(1);
    expect(d.runnerOrSkillsPaths).toHaveLength(1);
  });

  it('is "combined" for host + skills change', () => {
    const d = classifyDiff(
      ['Dockerfile', 'container/skills/browser/SKILL.md'],
      OPTS,
    );
    expect(d.overall).toBe('combined');
  });

  it('flags migrations regardless of other paths', () => {
    const d = classifyDiff(
      ['src/db/migrations/007-new.ts', 'src/delivery.ts'],
      OPTS,
    );
    expect(d.touchesMigrations).toBe(true);
    expect(d.overall).toBe('host');
  });

  it('does not flag migrations when none touched', () => {
    const d = classifyDiff(['groups/main/CLAUDE.md'], OPTS);
    expect(d.touchesMigrations).toBe(false);
  });

  it('throws on excluded paths in the diff', () => {
    expect(() => classifyDiff(['.env'], OPTS)).toThrow(
      /unreachable or excluded path/,
    );
  });

  it('throws on data/ paths in the diff', () => {
    expect(() => classifyDiff(['data/something'], OPTS)).toThrow();
  });

  it('preserves original paths in output files', () => {
    const d = classifyDiff(
      ['groups/main/CLAUDE.md', 'src/delivery.ts'],
      OPTS,
    );
    expect(d.files.map((f) => f.path)).toEqual([
      'groups/main/CLAUDE.md',
      'src/delivery.ts',
    ]);
  });
});
