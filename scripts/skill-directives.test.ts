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
