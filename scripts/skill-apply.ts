// The skill application engine — executes `nc:` directives parsed from a SKILL.md.
//
// The agent is always the top-level applier; this engine is the deterministic
// accelerator it delegates to. Anything the engine can't do bounces back to the
// AGENT (which reads the same prose and applies it, the way skills work today) —
// never to the human, and never as a hard abort. The human is in the loop only
// for `prompt` inputs and inherently-human prose (e.g. clicking through Slack).
//
// Phases (the F2 runtime contract, minimal form):
//   1. parse + validate   — lint; a malformed skill never reaches apply
//   2. PLAN               — per directive: skip|apply|needs-input|agent — no writes
//   3. acquire inputs     — resolve every `prompt` via the injected Prompter
//   4. mutate             — copy/append/env-set, journaled + idempotent
//   5. run                — build/test/fetch (+ dep install) via injected exec
// Remove is derived from the journal — no hand-written REMOVE.md.
//
// The Prompter is what makes one engine serve two contexts:
//   • setup flow      → interactive prompter asks the user inline
//   • recipe rebuild  → headless prompter returns from a values map, or defers
//
// Usage: pnpm exec tsx scripts/skill-apply.ts <skillDir>     # plan (no writes)

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, appendFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseDirectives, promptVar, type Directive } from './skill-directives.js';

export interface Prompter {
  // Return the value, or undefined to DEFER (headless rebuild collects these).
  ask(varName: string, question: string, secret: boolean): Promise<string | undefined>;
}

export type StepStatus = 'skip' | 'apply' | 'needs-input' | 'agent';
export interface PlanStep {
  n: number;
  kind: string;
  line: number;
  status: StepStatus;
  detail: string;
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const has = (root: string, rel: string) => existsSync(join(root, rel));
const VAR_REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const destOf = (line: string) => (line.includes('->') ? line.split('->')[1].trim() : line.trim());
const srcOf = (line: string) => (line.includes('->') ? line.split('->')[0].trim() : line.trim());

function fileHasLine(root: string, rel: string, line: string): boolean {
  return read(join(root, rel))
    .split('\n')
    .some((l) => l.trim() === line.trim());
}
function pkgHasDep(root: string, name: string): boolean {
  try {
    const pkg = JSON.parse(read(join(root, 'package.json')) || '{}');
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
  } catch {
    return false;
  }
}
function envKeySet(root: string, key: string): boolean {
  return read(join(root, '.env'))
    .split('\n')
    .some((l) => {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      return m !== null && m[1] === key && m[2].trim().length > 0;
    });
}
// Does the array-of-objects JSON at `rel` already contain an element whose
// [key] equals `value`? The idempotency probe for json-merge.
function jsonArrayHasKey(root: string, rel: string, key: string, value: unknown): boolean {
  try {
    const arr = JSON.parse(read(join(root, rel)) || '[]');
    return Array.isArray(arr) && arr.some((el) => el !== null && typeof el === 'object' && (el as Record<string, unknown>)[key] === value);
  } catch {
    return false;
  }
}

// Per-directive idempotency check + "what it would do". Read-only.
function selfStatus(d: Directive, root: string): { status: StepStatus; detail: string } {
  switch (d.kind) {
    case 'copy': {
      const dests = d.body.map(destOf);
      const missing = dests.filter((p) => !has(root, p));
      const from = d.attrs['from-branch'] ? `fetch ${String(d.attrs['from-branch'])} → ` : '';
      return missing.length
        ? { status: 'apply', detail: `${from}copy ${missing.join(', ')} (absent)` }
        : { status: 'skip', detail: `${dests.join(', ')} present` };
    }
    case 'append': {
      const to = String(d.attrs.to ?? '');
      const line = d.body[0] ?? '';
      return fileHasLine(root, to, line)
        ? { status: 'skip', detail: `${to} already has the line` }
        : { status: 'apply', detail: `add to ${to}: ${line}` };
    }
    case 'dep': {
      const missing = d.body.filter((s) => !pkgHasDep(root, s.slice(0, s.lastIndexOf('@'))));
      return missing.length
        ? { status: 'apply', detail: `install ${missing.join(', ')}` }
        : { status: 'skip', detail: `${d.body.join(', ')} present` };
    }
    case 'run':
      return { status: 'apply', detail: `${String(d.attrs.effect ?? 'run')}: ${d.body.join(' && ')}` };
    case 'env-set': {
      const keys = d.body.map((l) => l.split('=')[0].trim());
      const missing = keys.filter((k) => !envKeySet(root, k));
      return missing.length
        ? { status: 'apply', detail: `set ${missing.join(', ')} in .env` }
        : { status: 'skip', detail: `${keys.join(', ')} already set` };
    }
    case 'env-sync':
      return { status: 'apply', detail: 'sync .env → data/env/env' };
    case 'json-merge': {
      const into = String(d.attrs.into ?? '');
      const key = String(d.attrs.key ?? '');
      let value: unknown;
      try {
        value = (JSON.parse(d.body.join('\n')) as Record<string, unknown>)[key];
      } catch {
        return { status: 'agent', detail: `nc:json-merge body is not parseable JSON — an agent applies it from the prose` };
      }
      return jsonArrayHasKey(root, into, key, value)
        ? { status: 'skip', detail: `${into} already has ${key}=${JSON.stringify(value)}` }
        : { status: 'apply', detail: `merge ${key}=${JSON.stringify(value)} into ${into}` };
    }
    case 'prompt':
      return { status: 'needs-input', detail: '' };
    default:
      return { status: 'agent', detail: `no deterministic handler for nc:${d.kind} — an agent applies it from the prose` };
  }
}

export function planSkill(skillDir: string, root: string): { steps: PlanStep[]; needsInput: string[]; agentSteps: number } {
  const directives = parseDirectives(read(join(skillDir, 'SKILL.md')));
  const self = directives.map((d) => ({ d, ...selfStatus(d, root) }));

  const consumers = new Map<string, number[]>();
  self.forEach(({ d }, i) => {
    for (const line of d.body) for (const m of line.matchAll(VAR_REF)) (consumers.get(m[1]) ?? consumers.set(m[1], []).get(m[1])!).push(i);
  });

  const steps: PlanStep[] = self.map(({ d, status, detail }, i) => {
    if (d.kind !== 'prompt') return { n: i + 1, kind: d.kind, line: d.line, status, detail };
    const v = promptVar(d) ?? '?';
    const tag = `${v}${d.args.includes('secret') ? ' (secret)' : ''}`;
    const cons = consumers.get(v) ?? [];
    const satisfied = cons.length > 0 && cons.every((j) => self[j].status === 'skip');
    return satisfied
      ? { n: i + 1, kind: d.kind, line: d.line, status: 'skip', detail: `${tag} — consumers already satisfied` }
      : { n: i + 1, kind: d.kind, line: d.line, status: 'needs-input', detail: `${tag} → asked during apply` };
  });

  return {
    steps,
    needsInput: steps.filter((s) => s.status === 'needs-input').map((s) => s.detail.split(' ')[0]),
    agentSteps: steps.filter((s) => s.status === 'agent').length,
  };
}

// ---------------------------------------------------------------------------
// Apply (phases 3–5) + journal-derived remove.
// ---------------------------------------------------------------------------

export type JournalEntry =
  | { op: 'wrote'; path: string }
  | { op: 'appended'; path: string; line: string }
  | { op: 'set-env'; key: string }
  | { op: 'json-merge'; path: string; key: string; value: unknown }
  | { op: 'ran'; cmd: string; undo?: string };

export interface AgentTask {
  kind: string;
  line: number;
  reason: string;
  prose: string; // the surrounding prose the agent reads to apply the step
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
  deferred: string[]; // prompt vars / blocked consumers with no value yet
  agentTasks: AgentTask[]; // bounced to an agent — NOT the human
  journal: JournalEntry[];
}

export interface ApplyOptions {
  prompter: Prompter;
  exec?: (cmd: string) => void | Promise<void>; // dep/run/branch-fetch; injectable for tests
  // Resolve which remote carries a `from-branch` registry branch. Defaults to a
  // generic resolver (env override → first remote that has the branch → origin);
  // setup injects one that reuses setup/lib/channels-remote.sh for exact parity.
  resolveRemote?: (branch: string) => string;
}

// A hardcoded `origin` breaks forks where the registry branch lives on
// `upstream`. Generic mirror of channels-remote.sh: explicit override → the
// first remote that actually has the branch → origin.
function defaultResolveRemote(branch: string, root: string): string {
  const override = process.env.NANOCLAW_CHANNELS_REMOTE;
  if (override) return override;
  const cap = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch {
      return '';
    }
  };
  const remotes = cap('git remote').split('\n').map((s) => s.trim()).filter(Boolean);
  const ordered = remotes.includes('origin') ? ['origin', ...remotes.filter((r) => r !== 'origin')] : remotes;
  for (const r of ordered) if (cap(`git ls-remote --heads ${r} ${branch}`).trim()) return r;
  return 'origin';
}

// The prose an agent reads when a step degrades: nearest heading + the
// paragraph immediately above the directive fence.
function proseFor(md: string, fenceLine1: number): string {
  const lines = md.split('\n');
  let i = fenceLine1 - 2;
  while (i >= 0 && lines[i].trim() === '') i--;
  const para: string[] = [];
  while (i >= 0 && lines[i].trim() !== '' && !lines[i].startsWith('#')) para.unshift(lines[i--]);
  let heading = '';
  for (let h = i; h >= 0; h--) if (lines[h].startsWith('#')) { heading = lines[h]; break; }
  return [heading, ...para].filter(Boolean).join('\n').trim();
}

function substitute(value: string, vars: Map<string, { value: string; secret: boolean }>): string {
  return value.replace(VAR_REF, (_, name) => {
    const v = vars.get(name);
    if (!v) throw new Error(`unresolved {{${name}}}`);
    return v.value;
  });
}

// The mutating twin of selfStatus. Records what it did to the journal so remove
// is derivable. Throws on failure → caught and bounced to an agent.
async function applyOne(
  d: Directive,
  ctx: { root: string; skillDir: string; exec: (c: string) => void | Promise<void>; resolveRemote: (b: string) => string; vars: Map<string, { value: string; secret: boolean }>; journal: JournalEntry[] },
): Promise<void> {
  const { root, skillDir, exec, vars, journal } = ctx;
  switch (d.kind) {
    case 'copy':
      if (d.attrs['from-branch']) {
        const b = String(d.attrs['from-branch']);
        const remote = ctx.resolveRemote(b);
        await exec(`git fetch ${remote} ${b}`);
        for (const l of d.body) await exec(`git show ${remote}/${b}:${srcOf(l)} > ${destOf(l)}`);
      } else {
        for (const l of d.body) {
          const dst = join(root, destOf(l));
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(join(skillDir, srcOf(l)), dst);
        }
      }
      for (const l of d.body) journal.push({ op: 'wrote', path: destOf(l) });
      break;
    case 'append': {
      const to = String(d.attrs.to);
      const marker = typeof d.attrs.at === 'string' ? d.attrs.at : undefined;
      const target = join(root, to);
      if (marker) {
        // Insert before the `// <<< <marker>` closing line of a dormant marker
        // region, matching that line's indentation. removeSkill still deletes
        // by line (position-agnostic), so the journal entry is unchanged.
        const close = `<<< ${marker}`;
        for (const line of d.body) {
          const lines = read(target).split('\n');
          const idx = lines.findIndex((l) => l.includes(close));
          if (idx === -1) throw new Error(`append marker "${marker}" not found in ${to}`);
          const indent = lines[idx].match(/^\s*/)?.[0] ?? '';
          lines.splice(idx, 0, indent + line);
          writeFileSync(target, lines.join('\n'));
          journal.push({ op: 'appended', path: to, line });
        }
      } else {
        for (const line of d.body) {
          appendFileSync(target, (read(target).endsWith('\n') || read(target) === '' ? '' : '\n') + line + '\n');
          journal.push({ op: 'appended', path: to, line });
        }
      }
      break;
    }
    case 'dep': {
      await exec(`pnpm add ${d.body.join(' ')}`);
      const names = d.body.map((s) => s.slice(0, s.lastIndexOf('@'))).join(' ');
      journal.push({ op: 'ran', cmd: `pnpm add ${d.body.join(' ')}`, undo: `pnpm remove ${names}` });
      break;
    }
    case 'run':
      for (const cmd of d.body) {
        // Interpolate prompted {{vars}} the same way env-set does, so a run can
        // call `ncl ... {{owner_email}}` to wire from collected input. A command
        // with no {{...}} (build/test) is returned unchanged; an unresolved var
        // throws → caught → deferred (the prompt hasn't been answered yet).
        await exec(substitute(cmd, vars));
        // Journal the ORIGINAL command (placeholders intact) — never the
        // substituted form — so a secret interpolated into a run never lands in
        // the journal (or a remove replay).
        const undo = d.attrs.effect === 'external' && typeof d.attrs.remove === 'string' ? d.attrs.remove : undefined;
        journal.push({ op: 'ran', cmd, undo });
      }
      break;
    case 'env-set': {
      const envPath = join(root, '.env');
      for (const entry of d.body) {
        const eq = entry.indexOf('=');
        const key = entry.slice(0, eq).trim();
        const value = substitute(entry.slice(eq + 1).trim(), vars); // throws if a {{var}} is unresolved
        if (!envKeySet(root, key)) {
          appendFileSync(envPath, (read(envPath).endsWith('\n') || read(envPath) === '' ? '' : '\n') + `${key}=${value}\n`);
          journal.push({ op: 'set-env', key });
        }
      }
      break;
    }
    case 'env-sync':
      mkdirSync(join(root, 'data/env'), { recursive: true });
      copyFileSync(join(root, '.env'), join(root, 'data/env/env'));
      break;
    case 'json-merge': {
      const into = String(d.attrs.into);
      const key = String(d.attrs.key);
      const obj = JSON.parse(d.body.join('\n')) as Record<string, unknown>;
      const target = join(root, into);
      const arr = JSON.parse(read(target) || '[]') as unknown[];
      if (!Array.isArray(arr)) throw new Error(`${into} is not a JSON array`);
      const value = obj[key];
      // Idempotent: only push when no element already matches on the key.
      if (!arr.some((el) => el !== null && typeof el === 'object' && (el as Record<string, unknown>)[key] === value)) {
        arr.push(obj);
        writeFileSync(target, JSON.stringify(arr, null, 2) + '\n');
        journal.push({ op: 'json-merge', path: into, key, value });
      }
      break;
    }
    default:
      throw new Error(`no handler for nc:${d.kind}`);
  }
}

export async function applySkill(skillDir: string, root: string, opts: ApplyOptions): Promise<ApplyResult> {
  // Lint (validate()) is the authoring/CI gate, run before a skill ships — NOT
  // here. Apply is best-effort: an unknown directive (a typo lint should have
  // caught, or one newer than this engine) bounces to an agent, never blocks.
  const md = read(join(skillDir, 'SKILL.md'));
  const directives = parseDirectives(md);
  const exec = opts.exec ?? (() => { throw new Error('no exec provided'); });
  const resolveRemote = opts.resolveRemote ?? ((b: string) => defaultResolveRemote(b, root));
  const vars = new Map<string, { value: string; secret: boolean }>();
  const res: ApplyResult = { applied: [], skipped: [], deferred: [], agentTasks: [], journal: [] };
  const bounce = (d: Directive, reason: string) => res.agentTasks.push({ kind: d.kind, line: d.line, reason, prose: proseFor(md, d.line) });

  for (const d of directives) {
    try {
      if (d.kind === 'prompt') {
        const v = promptVar(d)!;
        const val = await opts.prompter.ask(v, d.body.join(' '), d.args.includes('secret'));
        if (val === undefined) res.deferred.push(v);
        else vars.set(v, { value: val, secret: d.args.includes('secret') });
        continue;
      }
      const st = selfStatus(d, root);
      if (st.status === 'agent') { bounce(d, 'no deterministic handler'); continue; }
      if (st.status === 'skip') { res.skipped.push(`${d.kind}: ${st.detail}`); continue; }
      await applyOne(d, { root, skillDir, exec, resolveRemote, vars, journal: res.journal });
      res.applied.push(`${d.kind}: ${st.detail}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/unresolved \{\{/.test(msg)) res.deferred.push(msg); // blocked on a prompt input
      else bounce(d, `engine could not apply (${msg}) — an agent applies it from the prose`);
    }
  }
  return res;
}

// Remove is the journal played backwards — no hand-written REMOVE.md.
export async function removeSkill(root: string, journal: JournalEntry[], exec?: (c: string) => void | Promise<void>): Promise<void> {
  for (const e of [...journal].reverse()) {
    if (e.op === 'wrote') rmSync(join(root, e.path), { force: true });
    else if (e.op === 'appended') {
      const p = join(root, e.path);
      writeFileSync(p, read(p).split('\n').filter((l) => l.trim() !== e.line.trim()).join('\n'));
    } else if (e.op === 'set-env') {
      const p = join(root, '.env');
      writeFileSync(p, read(p).split('\n').filter((l) => !l.startsWith(`${e.key}=`)).join('\n'));
    } else if (e.op === 'json-merge') {
      const p = join(root, e.path);
      const arr = JSON.parse(read(p) || '[]') as unknown[];
      if (Array.isArray(arr)) {
        writeFileSync(p, JSON.stringify(arr.filter((el) => !(el !== null && typeof el === 'object' && (el as Record<string, unknown>)[e.key] === e.value)), null, 2) + '\n');
      }
    } else if (e.op === 'ran' && e.undo && exec) {
      await exec(e.undo);
    }
  }
}

// CLI — the planner (no writes)
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const skillDir = process.argv[2];
  if (!skillDir) {
    console.error('usage: pnpm exec tsx scripts/skill-apply.ts <skillDir>');
    process.exit(2);
  }
  const root = process.cwd();
  const { steps, needsInput, agentSteps } = planSkill(skillDir, root);
  console.log(`PLAN ${skillDir}   project: ${root}\n`);
  const icon: Record<StepStatus, string> = { skip: '✓ skip', apply: '→ apply', 'needs-input': '? human', agent: '↳ agent' };
  for (const s of steps) console.log(`${String(s.n).padStart(2)}. ${icon[s.status].padEnd(8)} ${s.kind.padEnd(9)} ${s.detail}`);
  console.log(`\nneeds human input: ${needsInput.join(', ') || '(none)'}    →agent: ${agentSteps}`);
}
