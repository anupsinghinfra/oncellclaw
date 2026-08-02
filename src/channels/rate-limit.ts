/**
 * In-memory rate limiting for the web channel.
 *
 * Two small, pure limiters with an injected clock (tests never sleep):
 *
 *  - SlidingWindowLimiter — counts events per key in a rolling window.
 *    Used for auth FAILURES per client IP: `check` is consulted BEFORE the
 *    token compare, so a brute-forcer who has exhausted their budget never
 *    reaches the comparison at all, and `record` is called on each failure.
 *
 *  - TokenBucketLimiter — burst-friendly budget per key. Used for accepted
 *    messages per group: a full bucket lets a real conversation burst, the
 *    refill rate caps sustained throughput.
 *
 * State is process-local by design — the host is a single process, and a
 * restart forgiving both budgets is acceptable. Both limiters prune stale
 * entries opportunistically (at most one full sweep per window/minute), so
 * an attacker rotating keys cannot grow the maps without bound faster than
 * they are swept.
 */

export interface Clock {
  /** Milliseconds since epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface LimitDecision {
  allowed: boolean;
  /** Whole seconds until the caller should retry. 0 when allowed. */
  retryAfterSec: number;
}

const MS_PER_MIN = 60_000;

/**
 * Parse a positive-integer per-minute rate from an env value. Anything
 * missing or unusable falls back — a misconfigured limit must degrade to
 * the default, never to "unlimited" or "blocked".
 */
export function parseRatePerMin(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/** Rolling-window event counter: at most `limit` events per key per window. */
export class SlidingWindowLimiter {
  private readonly events = new Map<string, number[]>();
  private lastSweepAt: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.lastSweepAt = clock.now();
  }

  /** Is this key currently over budget? Does NOT consume anything. */
  check(key: string): LimitDecision {
    const now = this.clock.now();
    this.maybeSweep(now);
    const recent = this.recent(key, now);
    if (recent.length < this.limit) return { allowed: true, retryAfterSec: 0 };
    // The window frees up when the oldest counted event ages out.
    const oldest = recent[0]!;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
  }

  /** Count one event against this key. */
  record(key: string): void {
    const now = this.clock.now();
    const recent = this.recent(key, now);
    recent.push(now);
    this.events.set(key, recent);
  }

  /** Number of tracked keys — exposed for pruning tests. */
  size(): number {
    return this.events.size;
  }

  /** Events for a key still inside the window (also compacts that key). */
  private recent(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const kept = (this.events.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.events.delete(key);
    else this.events.set(key, kept);
    return kept;
  }

  /** Full sweep at most once per window — bounds memory under key churn. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.events) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length === 0) this.events.delete(key);
      else this.events.set(key, kept);
    }
  }
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket per key: capacity `burst` (default = the per-minute rate),
 * refilled continuously at `ratePerMin` tokens/minute.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepAt: number;
  private readonly burst: number;

  constructor(
    private readonly ratePerMin: number,
    private readonly clock: Clock = systemClock,
    burst?: number,
  ) {
    this.burst = burst ?? ratePerMin;
    this.lastSweepAt = clock.now();
  }

  /** Take one token for this key, or report how long until one exists. */
  tryTake(key: string): LimitDecision {
    const now = this.clock.now();
    this.maybeSweep(now);
    const bucket = this.refilled(this.buckets.get(key), now);
    if (bucket.tokens >= 1) {
      this.buckets.set(key, { tokens: bucket.tokens - 1, updatedAt: now });
      return { allowed: true, retryAfterSec: 0 };
    }
    this.buckets.set(key, bucket);
    const msPerToken = MS_PER_MIN / this.ratePerMin;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(((1 - bucket.tokens) * msPerToken) / 1000)) };
  }

  /** Number of tracked keys — exposed for pruning tests. */
  size(): number {
    return this.buckets.size;
  }

  private refilled(bucket: Bucket | undefined, now: number): Bucket {
    if (!bucket) return { tokens: this.burst, updatedAt: now };
    const refill = ((now - bucket.updatedAt) / MS_PER_MIN) * this.ratePerMin;
    return { tokens: Math.min(this.burst, bucket.tokens + refill), updatedAt: now };
  }

  /**
   * Full sweep at most once per minute: a bucket that has refilled to
   * capacity carries no information (a fresh key gets the same budget), so
   * it is dropped.
   */
  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < MS_PER_MIN) return;
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now).tokens >= this.burst) this.buckets.delete(key);
    }
  }
}
