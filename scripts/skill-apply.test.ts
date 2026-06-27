import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySkill, removeSkill, planSkill, type Prompter } from './skill-apply.js';

// A synthetic skill exercising the fs handlers for real (no network), plus one
// directive the engine can't handle — to prove it bounces to an agent, not abort.
const SKILL = `# demo skill

## Copy the file
\`\`\`nc:copy
resources/sample.ts -> src/sample.ts
\`\`\`

## Register it
\`\`\`nc:append to:src/barrel.ts
import './sample.js';
\`\`\`

## Capture and store a secret
\`\`\`nc:prompt token secret
Paste the demo token.
\`\`\`
\`\`\`nc:env-set
DEMO_TOKEN={{token}}
\`\`\`

## A step the engine can't do deterministically
Hand-edit the scheduler to register the demo hook.
\`\`\`nc:patch-scheduler
register demo
\`\`\`
`;

let root: string;
let skillDir: string;
const headless = (vals: Record<string, string>): Prompter => ({ async ask(name) { return vals[name]; } });
const recordingExec = () => {
  const cmds: string[] = [];
  return { cmds, exec: (c: string) => void cmds.push(c) };
};

beforeEach(() => {
  skillDir = mkdtempSync(join(tmpdir(), 'nc-skill-'));
  root = mkdtempSync(join(tmpdir(), 'nc-proj-'));
  mkdirSync(join(skillDir, 'resources'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL);
  writeFileSync(join(skillDir, 'resources/sample.ts'), 'export const sample = true;\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/barrel.ts'), '// channel barrel\n');
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
});

describe('apply engine lifecycle', () => {
  it('applies fs directives, captures the secret, and bounces the unknown step to an agent', async () => {
    const { exec } = recordingExec();
    const res = await applySkill(skillDir, root, { prompter: headless({ token: 'sekret-123' }), exec });

    // mutations happened
    expect(existsSync(join(root, 'src/sample.ts'))).toBe(true);
    expect(readFileSync(join(root, 'src/barrel.ts'), 'utf8')).toContain("import './sample.js';");
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('DEMO_TOKEN=sekret-123');

    // the unknown directive went to an agent — with prose — not the human, not an abort
    expect(res.agentTasks).toHaveLength(1);
    expect(res.agentTasks[0].kind).toBe('patch-scheduler');
    expect(res.agentTasks[0].prose).toContain('Hand-edit the scheduler');
    expect(res.deferred).toEqual([]);
    expect(res.journal.length).toBeGreaterThanOrEqual(3); // wrote + appended + set-env
  });

  it('is idempotent — a second apply changes nothing', async () => {
    const p = headless({ token: 'sekret-123' });
    await applySkill(skillDir, root, { prompter: p, exec: () => {} });
    const second = await applySkill(skillDir, root, { prompter: p, exec: () => {} });
    expect(second.applied).toEqual([]); // everything already applied
    expect(second.journal).toEqual([]); // nothing mutated
    expect(second.skipped.length).toBeGreaterThanOrEqual(3);
  });

  it('removes cleanly from the journal — no hand-written REMOVE.md', async () => {
    const res = await applySkill(skillDir, root, { prompter: headless({ token: 'sekret-123' }), exec: () => {} });
    await removeSkill(root, res.journal);
    expect(existsSync(join(root, 'src/sample.ts'))).toBe(false);
    expect(readFileSync(join(root, 'src/barrel.ts'), 'utf8')).not.toContain("import './sample.js';");
    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain('DEMO_TOKEN');
  });

  it('defers a prompt (and its consumer) when the prompter has no value — headless rebuild', async () => {
    const res = await applySkill(skillDir, root, { prompter: headless({}), exec: () => {} });
    expect(res.deferred).toContain('token'); // prompt deferred
    expect(res.deferred.some((d) => /unresolved \{\{token\}\}/.test(d))).toBe(true); // env-set blocked on it
    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain('DEMO_TOKEN');
  });

  it('plan marks the unknown step ↳agent and the prompt ? needs-input before any write', () => {
    const { steps, agentSteps, needsInput } = planSkill(skillDir, root);
    expect(agentSteps).toBe(1);
    expect(needsInput).toContain('token');
    expect(existsSync(join(root, 'src/sample.ts'))).toBe(false); // planning mutated nothing
  });
});

// json-merge: push a body object into an array-of-objects JSON file, keyed.
const JSON_MERGE_SKILL = `# json-merge demo

## Register the CLI tool
\`\`\`nc:json-merge into:container/cli-tools.json key:name
{ "name": "@openai/codex", "version": "0.138.0" }
\`\`\`
`;

describe('json-merge directive', () => {
  let jroot: string;
  let jskill: string;
  beforeEach(() => {
    jskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    jroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(jskill, 'SKILL.md'), JSON_MERGE_SKILL);
    mkdirSync(join(jroot, 'container'), { recursive: true });
    writeFileSync(join(jroot, 'container/cli-tools.json'), '[\n  { "name": "vercel", "version": "52.2.1" }\n]\n');
  });

  it('pushes the object, preserving 2-space indent + trailing newline', async () => {
    const res = await applySkill(jskill, jroot, { prompter: headless({}), exec: () => {} });
    const out = readFileSync(join(jroot, 'container/cli-tools.json'), 'utf8');
    expect(out.endsWith('\n')).toBe(true);
    const arr = JSON.parse(out);
    expect(arr).toEqual([
      { name: 'vercel', version: '52.2.1' },
      { name: '@openai/codex', version: '0.138.0' },
    ]);
    expect(out).toBe(JSON.stringify(arr, null, 2) + '\n'); // 2-space indent
    expect(res.journal.some((e) => e.op === 'json-merge')).toBe(true);
  });

  it('is idempotent — re-applying does not duplicate the element', async () => {
    await applySkill(jskill, jroot, { prompter: headless({}), exec: () => {} });
    const second = await applySkill(jskill, jroot, { prompter: headless({}), exec: () => {} });
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(1);
    const arr = JSON.parse(readFileSync(join(jroot, 'container/cli-tools.json'), 'utf8'));
    expect(arr.filter((e: { name: string }) => e.name === '@openai/codex')).toHaveLength(1);
  });

  it('removeSkill drops the element whose key matches', async () => {
    const res = await applySkill(jskill, jroot, { prompter: headless({}), exec: () => {} });
    await removeSkill(jroot, res.journal);
    const arr = JSON.parse(readFileSync(join(jroot, 'container/cli-tools.json'), 'utf8'));
    expect(arr).toEqual([{ name: 'vercel', version: '52.2.1' }]);
  });

  it('plan marks it →apply when absent, ✓skip when present', () => {
    const before = planSkill(jskill, jroot);
    expect(before.steps[0].status).toBe('apply');
    // simulate already-merged
    writeFileSync(
      join(jroot, 'container/cli-tools.json'),
      JSON.stringify([{ name: '@openai/codex', version: '0.138.0' }], null, 2) + '\n',
    );
    const after = planSkill(jskill, jroot);
    expect(after.steps[0].status).toBe('skip');
  });
});

// append at:<marker>: insert before a dormant region's closing line.
const MARKER_FILE = ['const STEPS = {', "  auth: () => import('./auth.js'),", '  // >>> nanoclaw:setup-steps', '  // <<< nanoclaw:setup-steps', '};', ''].join('\n');
const APPEND_AT_SKILL = `# append-at demo

## Register a setup step
\`\`\`nc:append to:setup/index.ts at:nanoclaw:setup-steps
codex: () => import('./codex.js'),
\`\`\`
`;
const APPEND_EOF_SKILL = `# append-eof demo

## Register at EOF
\`\`\`nc:append to:setup/index.ts
// trailing line
\`\`\`
`;

describe('append at:<marker>', () => {
  let aroot: string;
  let askill: string;
  beforeEach(() => {
    askill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    aroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    mkdirSync(join(aroot, 'setup'), { recursive: true });
    writeFileSync(join(aroot, 'setup/index.ts'), MARKER_FILE);
  });

  it('inserts before the `<<< marker` line, matching its indentation', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_AT_SKILL);
    await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    const out = readFileSync(join(aroot, 'setup/index.ts'), 'utf8').split('\n');
    const closeIdx = out.findIndex((l) => l.includes('<<< nanoclaw:setup-steps'));
    expect(out[closeIdx - 1]).toBe("  codex: () => import('./codex.js'),"); // inserted just above, 2-space indent
    expect(out[closeIdx - 2]).toContain('>>> nanoclaw:setup-steps'); // open marker untouched
  });

  it('is idempotent (whole-file line check) regardless of position', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_AT_SKILL);
    await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    const second = await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    expect(second.applied).toEqual([]);
    const count = readFileSync(join(aroot, 'setup/index.ts'), 'utf8').split('\n').filter((l) => l.trim() === "codex: () => import('./codex.js'),").length;
    expect(count).toBe(1);
  });

  it('removeSkill deletes the inserted line (position-agnostic, by trimmed line)', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_AT_SKILL);
    const res = await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    await removeSkill(aroot, res.journal);
    expect(readFileSync(join(aroot, 'setup/index.ts'), 'utf8')).not.toContain("codex: () => import('./codex.js'),");
  });

  it('without at: still appends at EOF (unchanged behavior)', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_EOF_SKILL);
    await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    const lines = readFileSync(join(aroot, 'setup/index.ts'), 'utf8').split('\n').filter(Boolean);
    expect(lines[lines.length - 1]).toBe('// trailing line'); // at EOF, not before the marker
  });
});

// nc:run substitutes prompted {{vars}} — this is what lets wiring be "collect
// input + call ncl", with no nc:wire directive.
const RUN_WIRE_SKILL = `# run-substitute demo

## Collect input
\`\`\`nc:prompt owner_email
Your email.
\`\`\`

## Wire via ncl
\`\`\`nc:run effect:wire
ncl messaging-groups create --channel-type resend --platform-id resend:{{owner_email}} --is-group 0
ncl messaging-groups send --channel-type resend --platform-id resend:{{owner_email}} --text "hello"
\`\`\`

## A var-free build run
\`\`\`nc:run effect:build
pnpm run build
\`\`\`
`;

describe('nc:run variable substitution', () => {
  let rroot: string;
  let rskill: string;
  beforeEach(() => {
    rskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    rroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(rskill, 'SKILL.md'), RUN_WIRE_SKILL);
    writeFileSync(join(rroot, 'package.json'), '{"name":"scratch"}');
  });

  it('interpolates a prompted {{var}} into run commands; var-free runs pass through unchanged', async () => {
    const { cmds, exec } = recordingExec();
    await applySkill(rskill, rroot, { prompter: headless({ owner_email: 'you@example.com' }), exec });
    expect(cmds).toContain(
      'ncl messaging-groups create --channel-type resend --platform-id resend:you@example.com --is-group 0',
    );
    expect(cmds).toContain(
      'ncl messaging-groups send --channel-type resend --platform-id resend:you@example.com --text "hello"',
    );
    expect(cmds).toContain('pnpm run build');
  });

  it('journals the ORIGINAL command (placeholders intact) — a substituted value never lands in the journal', async () => {
    const res = await applySkill(rskill, rroot, { prompter: headless({ owner_email: 'you@example.com' }), exec: () => {} });
    const ran = res.journal.filter((e) => e.op === 'ran').map((e) => 'cmd' in e ? e.cmd : '');
    expect(ran).toContain(
      'ncl messaging-groups create --channel-type resend --platform-id resend:{{owner_email}} --is-group 0',
    );
    expect(JSON.stringify(res.journal)).not.toContain('you@example.com');
  });

  it('defers a wiring run when its {{var}} prompt is unanswered (degrade, not crash)', async () => {
    const { cmds, exec } = recordingExec();
    const res = await applySkill(rskill, rroot, { prompter: headless({}), exec });
    expect(res.deferred.some((d) => /unresolved \{\{owner_email\}\}/.test(d))).toBe(true);
    expect(cmds.some((c) => c.startsWith('ncl'))).toBe(false); // no ncl ran with an unresolved value
    expect(cmds).toContain('pnpm run build'); // the var-free run still executes
  });
});
