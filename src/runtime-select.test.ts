import { describe, expect, it } from 'vitest';

import { resolveRuntimeKind } from './runtime-select.js';

describe('resolveRuntimeKind', () => {
  it('defaults to docker when nothing is configured', () => {
    expect(resolveRuntimeKind({})).toBe('docker');
  });

  it('selects oncell when ONCELL_API_KEY is set and no override given', () => {
    expect(resolveRuntimeKind({ oncellApiKey: 'oncell_sk_x' })).toBe('oncell');
  });

  it('explicit docker override wins even with an API key present', () => {
    expect(resolveRuntimeKind({ runtimeOverride: 'docker', oncellApiKey: 'oncell_sk_x' })).toBe('docker');
  });

  it('explicit oncell override selects oncell even without a key', () => {
    expect(resolveRuntimeKind({ runtimeOverride: 'oncell' })).toBe('oncell');
  });

  it('override is case/whitespace tolerant', () => {
    expect(resolveRuntimeKind({ runtimeOverride: ' Docker ', oncellApiKey: 'k' })).toBe('docker');
    expect(resolveRuntimeKind({ runtimeOverride: 'ONCELL' })).toBe('oncell');
  });

  it('unknown override falls back to key-based selection', () => {
    expect(resolveRuntimeKind({ runtimeOverride: 'podman' })).toBe('docker');
    expect(resolveRuntimeKind({ runtimeOverride: 'podman', oncellApiKey: 'k' })).toBe('oncell');
  });
});
