/**
 * Rate limiter math under a fake clock — no test sleeps.
 */
import { describe, it, expect } from 'vitest';

import { parseRatePerMin, SlidingWindowLimiter, TokenBucketLimiter, type Clock } from './rate-limit.js';

/** Manually advanced clock. */
function fakeClock(startMs = 1_000_000): Clock & { advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('parseRatePerMin', () => {
  it('parses a positive integer', () => {
    expect(parseRatePerMin('45', 20)).toBe(45);
  });

  it.each([undefined, '', 'abc', '0', '-3'])('falls back on unusable value %j', (raw) => {
    expect(parseRatePerMin(raw as string | undefined, 20)).toBe(20);
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows up to the limit and blocks the next check', () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowLimiter(3, 60_000, clock);

    for (let i = 0; i < 3; i++) {
      expect(limiter.check('ip-1').allowed).toBe(true);
      limiter.record('ip-1');
    }
    const blocked = limiter.check('ip-1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('reports retry-after as the time until the oldest event ages out', () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowLimiter(2, 60_000, clock);
    limiter.record('ip-1'); // t=0
    clock.advance(10_000);
    limiter.record('ip-1'); // t=10s
    clock.advance(5_000); // t=15s — oldest ages out at t=60s → 45s left
    expect(limiter.check('ip-1')).toEqual({ allowed: false, retryAfterSec: 45 });
  });

  it('frees budget as the window slides', () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowLimiter(2, 60_000, clock);
    limiter.record('ip-1');
    limiter.record('ip-1');
    expect(limiter.check('ip-1').allowed).toBe(false);

    clock.advance(60_001);
    expect(limiter.check('ip-1').allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowLimiter(1, 60_000, clock);
    limiter.record('ip-1');
    expect(limiter.check('ip-1').allowed).toBe(false);
    expect(limiter.check('ip-2').allowed).toBe(true);
  });

  it('prunes stale keys so churn cannot grow the map unboundedly', () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowLimiter(5, 60_000, clock);
    for (let i = 0; i < 100; i++) limiter.record(`ip-${i}`);
    expect(limiter.size()).toBe(100);

    clock.advance(60_001);
    limiter.check('ip-x'); // any operation past the window triggers the sweep
    expect(limiter.size()).toBe(0);
  });
});

describe('TokenBucketLimiter', () => {
  it('allows a full burst immediately, then blocks', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter(30, clock);

    for (let i = 0; i < 30; i++) {
      expect(limiter.tryTake('group').allowed).toBe(true);
    }
    const blocked = limiter.tryTake('group');
    expect(blocked.allowed).toBe(false);
    // Rate 30/min = one token per 2s → next token ~2s away.
    expect(blocked.retryAfterSec).toBe(2);
  });

  it('refills at the per-minute rate', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter(30, clock); // 1 token / 2s
    for (let i = 0; i < 30; i++) limiter.tryTake('group');
    expect(limiter.tryTake('group').allowed).toBe(false);

    clock.advance(2_000); // exactly one token refilled
    expect(limiter.tryTake('group').allowed).toBe(true);
    expect(limiter.tryTake('group').allowed).toBe(false);
  });

  it('caps refill at the burst size', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter(2, clock);
    limiter.tryTake('group');
    clock.advance(3_600_000); // an hour idle refills to capacity, not beyond
    expect(limiter.tryTake('group').allowed).toBe(true);
    expect(limiter.tryTake('group').allowed).toBe(true);
    expect(limiter.tryTake('group').allowed).toBe(false);
  });

  it('tracks keys independently', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter(1, clock);
    expect(limiter.tryTake('a').allowed).toBe(true);
    expect(limiter.tryTake('a').allowed).toBe(false);
    expect(limiter.tryTake('b').allowed).toBe(true);
  });

  it('honors an explicit burst larger than the rate', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter(1, clock, 5);
    for (let i = 0; i < 5; i++) expect(limiter.tryTake('a').allowed).toBe(true);
    const blocked = limiter.tryTake('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60); // 1/min → a full minute per token
  });

  it('prunes buckets that have refilled to capacity', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter(60, clock); // refills fully in 1 min
    for (let i = 0; i < 50; i++) limiter.tryTake(`g-${i}`);
    expect(limiter.size()).toBe(50);

    clock.advance(60_001); // all buckets back to full → carry no information
    limiter.tryTake('fresh'); // any operation past the sweep interval
    expect(limiter.size()).toBe(1); // only the key just touched
  });

  it('retains buckets that are still owed tokens across a sweep', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter(1, clock); // refills 1/min, burst 1
    limiter.tryTake('slow'); // empty now; needs a full minute to refill
    clock.advance(61_000); // sweep runs, but bucket refilled to full → pruned is fine
    // Immediately drain again and advance less than a refill.
    limiter.tryTake('slow');
    clock.advance(30_000);
    expect(limiter.tryTake('slow').allowed).toBe(false); // still owed — state kept
  });
});
