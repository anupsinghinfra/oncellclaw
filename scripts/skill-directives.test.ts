import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDirectives, validate, promptVar, resolveChatCoreVersion } from './skill-directives.js';

// Guards the structured-directive format against the converted add-slack skill:
// red if the conversion drifts (a directive dropped/renamed) or the parser breaks.
const slack = readFileSync('.claude/skills/add-slack/SKILL.md', 'utf8');
const directives = parseDirectives(slack);

describe('skill-directives parser, on the converted add-slack', () => {
  it('extracts the apply + credential directives in document order', () => {
    expect(directives.map((d) => d.kind)).toEqual([
      'copy', // step 1: adapter + test from the channels branch
      'append', // step 2: barrel registration
      'dep', // step 3: pinned package
      'run', // step 4: build
      'run', // step 4: test
      'prompt', // credentials: capture bot token
      'prompt', // credentials: capture signing secret
      'env-set', // credentials: write captured values to .env
      'env-sync', // credentials: sync to container
    ]);
  });

  it('reads copy as a branch fetch with both files', () => {
    const copy = directives.find((d) => d.kind === 'copy')!;
    expect(copy.attrs['from-branch']).toBe('channels');
    expect(copy.body).toEqual(['src/channels/slack.ts', 'src/channels/slack-registration.test.ts']);
  });

  it('reads the barrel append target and line', () => {
    const append = directives.find((d) => d.kind === 'append')!;
    expect(append.attrs.to).toBe('src/channels/index.ts');
    expect(append.body).toEqual(["import './slack.js';"]);
  });

  it('reads the dependency pinned exactly', () => {
    const dep = directives.find((d) => d.kind === 'dep')!;
    expect(dep.body).toEqual(['@chat-adapter/slack@4.26.0']);
  });

  it('tags the runs with their effects', () => {
    expect(directives.filter((d) => d.kind === 'run').map((d) => d.attrs.effect)).toEqual(['build', 'test']);
  });

  it('captures each prompt into a named, secret variable — no destination baked in', () => {
    const prompts = directives.filter((d) => d.kind === 'prompt');
    expect(prompts.map(promptVar)).toEqual(['bot_token', 'signing_secret']);
    for (const p of prompts) expect(p.args).toContain('secret');
    // The prompt body is the question; it does not mention env at all.
    expect(prompts[0].body.join(' ')).toMatch(/Bot User OAuth Token/);
  });

  it('wires the captured variables into env-set via {{var}} references', () => {
    const envSet = directives.find((d) => d.kind === 'env-set')!;
    expect(envSet.body).toEqual(['SLACK_BOT_TOKEN={{bot_token}}', 'SLACK_SIGNING_SECRET={{signing_secret}}']);
  });

  it('passes validation (well-formed, pinned, every {{var}} captured first)', () => {
    expect(validate(directives)).toEqual([]);
  });

  it('keeps its @chat-adapter pin in sync with our chat core (drift guard)', () => {
    const chat = resolveChatCoreVersion(process.cwd());
    expect(chat).toMatch(/^\d+\.\d+\.\d+/); // our lockfile resolves a real chat version
    expect(validate(directives, { chatVersion: chat })).toEqual([]); // add-slack matches it
  });

  it('ignores plain (non-nc:) code fences so prose stays the floor', () => {
    const withProse = slack + '\n```bash\nrm -rf /\n```\n';
    expect(parseDirectives(withProse).map((d) => d.kind)).toEqual(directives.map((d) => d.kind));
  });
});

describe('validation catches malformed directives', () => {
  it('flags an unpinned dependency and an unknown directive', () => {
    const md = ['```nc:dep', '@chat-adapter/slack@latest', '```', '', '```nc:frobnicate', 'x', '```'].join('\n');
    const problems = validate(parseDirectives(md));
    expect(problems.some((p) => /exact semver/.test(p.message))).toBe(true);
    expect(problems.some((p) => /unknown directive/.test(p.message))).toBe(true);
  });

  it('flags an env-set that references a variable no prompt captured', () => {
    const md = ['```nc:env-set', 'SLACK_BOT_TOKEN={{bot_token}}', '```'].join('\n');
    const problems = validate(parseDirectives(md));
    expect(problems.some((p) => /\{\{bot_token\}\} but no earlier nc:prompt/.test(p.message))).toBe(true);
  });

  it('flags a @chat-adapter pin that does not match the chat core', () => {
    const md = ['```nc:dep', '@chat-adapter/slack@4.27.0', '```'].join('\n');
    const problems = validate(parseDirectives(md), { chatVersion: '4.26.0' });
    expect(problems.some((p) => /must match the chat package/.test(p.message))).toBe(true);
  });

  it('accepts a @chat-adapter pin that matches the chat core', () => {
    const md = ['```nc:dep', '@chat-adapter/slack@4.26.0', '```'].join('\n');
    expect(validate(parseDirectives(md), { chatVersion: '4.26.0' })).toEqual([]);
  });
});

describe('json-merge directive', () => {
  const codex = ['```nc:json-merge into:container/cli-tools.json key:name', '{ "name": "@openai/codex", "version": "0.138.0" }', '```'].join('\n');

  it('parses into/key attrs and the JSON object body', () => {
    const [d] = parseDirectives(codex);
    expect(d.kind).toBe('json-merge');
    expect(d.attrs.into).toBe('container/cli-tools.json');
    expect(d.attrs.key).toBe('name');
    expect(JSON.parse(d.body.join('\n'))).toEqual({ name: '@openai/codex', version: '0.138.0' });
  });

  it('passes validation when into + key + a parseable object are all present', () => {
    expect(validate(parseDirectives(codex))).toEqual([]);
  });

  it('flags a missing into:', () => {
    const md = ['```nc:json-merge key:name', '{ "name": "x" }', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /requires into:/.test(p.message))).toBe(true);
  });

  it('flags a missing key:', () => {
    const md = ['```nc:json-merge into:container/cli-tools.json', '{ "name": "x" }', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /requires key:/.test(p.message))).toBe(true);
  });

  it('flags an unparseable body', () => {
    const md = ['```nc:json-merge into:f.json key:name', '{ not json', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /parseable JSON object/.test(p.message))).toBe(true);
  });

  it('flags a body that is an array, not a single object', () => {
    const md = ['```nc:json-merge into:f.json key:name', '[{ "name": "x" }]', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /single JSON object/.test(p.message))).toBe(true);
  });

  it('flags a body missing the match key field', () => {
    const md = ['```nc:json-merge into:f.json key:name', '{ "version": "1.0.0" }', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /no "name" field/.test(p.message))).toBe(true);
  });
});

describe('append at:<marker> attribute', () => {
  it('parses an optional at:<marker> alongside to:', () => {
    const md = ['```nc:append to:setup/index.ts at:nanoclaw:setup-steps', "  codex: () => import('./codex.js'),", '```'].join('\n');
    const [d] = parseDirectives(md);
    expect(d.kind).toBe('append');
    expect(d.attrs.to).toBe('setup/index.ts');
    expect(d.attrs.at).toBe('nanoclaw:setup-steps');
  });

  it('still validates an append that carries at: (to + a line are all it needs)', () => {
    const md = ['```nc:append to:setup/index.ts at:nanoclaw:setup-steps', "  codex: () => import('./codex.js'),", '```'].join('\n');
    expect(validate(parseDirectives(md))).toEqual([]);
  });
});
