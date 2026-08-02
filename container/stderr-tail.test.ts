/**
 * Stderr-tail capture for provider subprocess failures.
 *
 * The pure module is imported directly (it has no bun deps); the wiring
 * into the claude provider is pinned structurally because the provider
 * transitively imports bun:sqlite and can only execute under Bun.
 *
 * The behavioral scenario mirrors a stubbed failing binary: a subprocess
 * writes an explanation to stderr and exits 1 — the SDK's error ("exited
 * with code 1") must come out carrying that explanation.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

import { createStderrTail, enrichWithStderr, STDERR_TAIL_MAX_BYTES } from './agent-runner/src/providers/stderr-tail.js';

describe('createStderrTail', () => {
  it('captures chunks in order and trims whitespace', () => {
    const tail = createStderrTail();
    tail.append('--dangerously-skip-permissions cannot be used as root\n');
    tail.append('unless IS_SANDBOX=1 is set\n');
    expect(tail.tail()).toBe('--dangerously-skip-permissions cannot be used as root\nunless IS_SANDBOX=1 is set');
  });

  it('keeps only the last capBytes under a stderr flood', () => {
    const tail = createStderrTail(16);
    tail.append('x'.repeat(1000));
    tail.append('THE ACTUAL ERROR');
    expect(tail.tail()).toBe('THE ACTUAL ERROR');
    expect(tail.tail().length).toBeLessThanOrEqual(16);
  });

  it('defaults to a 2KB cap', () => {
    const tail = createStderrTail();
    tail.append('a'.repeat(STDERR_TAIL_MAX_BYTES * 2));
    expect(tail.tail().length).toBe(STDERR_TAIL_MAX_BYTES);
  });

  it('is empty when the subprocess wrote nothing', () => {
    expect(createStderrTail().tail()).toBe('');
  });
});

describe('enrichWithStderr — the stubbed-failing-binary scenario', () => {
  it('attaches the captured stderr to the exit-code error, keeping the original as cause', () => {
    // Simulate the SDK stderr callback receiving the stub binary's output
    // before the process dies with code 1.
    const tail = createStderrTail();
    tail.append('Error: cannot use --dangerously-skip-permissions as root without IS_SANDBOX=1\n');
    const sdkError = new Error('Claude Code process exited with code 1');

    const enriched = enrichWithStderr(sdkError, tail.tail());

    expect(enriched.message).toBe(
      'Claude Code process exited with code 1 — claude stderr: ' +
        'Error: cannot use --dangerously-skip-permissions as root without IS_SANDBOX=1',
    );
    expect(enriched.cause).toBe(sdkError);
  });

  it('returns the original error untouched when no stderr was captured', () => {
    const sdkError = new Error('Claude Code process exited with code 1');
    expect(enrichWithStderr(sdkError, '')).toBe(sdkError);
  });

  it('wraps non-Error throwables', () => {
    const enriched = enrichWithStderr('boom', 'reason');
    expect(enriched).toBeInstanceOf(Error);
    expect(enriched.message).toBe('boom — claude stderr: reason');
  });
});

describe('claude provider wiring (structural — provider only runs under Bun)', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'container', 'agent-runner', 'src', 'providers', 'claude.ts'),
    'utf-8',
  );

  it('registers the SDK stderr callback and enriches thrown errors', () => {
    expect(source).toContain('stderr: (data: string) => stderrTail.append(data)');
    expect(source).toContain('throw enrichWithStderr(err, tail)');
  });

  it('declares IS_SANDBOX=1 in cell mode only — root + skip-permissions refusal', () => {
    expect(source).toContain("...(process.env.NANOCLAW_CELL === '1' ? { IS_SANDBOX: '1' } : {})");
  });
});
