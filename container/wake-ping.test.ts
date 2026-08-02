/**
 * Wake-on-pending-outbound — decision logic (pure) + cell-service wiring
 * (structural; cell-service only runs under Bun).
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

import { shouldPingHostWake, WAKE_PING_MIN_INTERVAL_MS, WAKE_STALE_MS } from './agent-runner/src/wake-ping.js';

const T0 = 1_000_000_000;

describe('shouldPingHostWake', () => {
  it('never pings when there is no outbound at all', () => {
    expect(shouldPingHostWake({ outboundMtimeMs: 0, lastStagedMtimeMs: 0, nowMs: T0, lastPingMs: 0 })).toBe(false);
  });

  it('never pings while the pump is caught up', () => {
    expect(
      shouldPingHostWake({
        outboundMtimeMs: T0,
        lastStagedMtimeMs: T0 + 1, // staged after the last write
        nowMs: T0 + WAKE_STALE_MS * 10,
        lastPingMs: 0,
      }),
    ).toBe(false);
  });

  it('gives a live pump its grace window before pinging', () => {
    const input = {
      outboundMtimeMs: T0 + 5_000,
      lastStagedMtimeMs: T0, // pump last staged before the new rows
      lastPingMs: 0,
    };
    expect(shouldPingHostWake({ ...input, nowMs: T0 + WAKE_STALE_MS - 1 })).toBe(false);
    expect(shouldPingHostWake({ ...input, nowMs: T0 + WAKE_STALE_MS })).toBe(true);
  });

  it('pings when the host NEVER staged and the outbound write has gone stale', () => {
    expect(
      shouldPingHostWake({
        outboundMtimeMs: T0,
        lastStagedMtimeMs: 0,
        nowMs: T0 + WAKE_STALE_MS,
        lastPingMs: 0,
      }),
    ).toBe(true);
  });

  it('throttles to one ping per interval', () => {
    const base = {
      outboundMtimeMs: T0 + 1_000,
      lastStagedMtimeMs: T0,
      nowMs: T0 + WAKE_STALE_MS * 3,
    };
    expect(shouldPingHostWake({ ...base, lastPingMs: base.nowMs - WAKE_PING_MIN_INTERVAL_MS + 1 })).toBe(false);
    expect(shouldPingHostWake({ ...base, lastPingMs: base.nowMs - WAKE_PING_MIN_INTERVAL_MS })).toBe(true);
  });
});

describe('cell-service wake watchdog wiring (structural)', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'container', 'agent-runner', 'src', 'cell-service.ts'),
    'utf-8',
  );

  it('pings the hosting preview /web/health, gated on the forwarded URL', () => {
    expect(source).toContain('startHostWakeWatchdog()');
    expect(source).toContain('ONCELLCLAW_HOST_PREVIEW_URL');
    expect(source).toContain('/web/health');
    expect(source).toContain('shouldPingHostWake');
    // Group cells never hold the web bearer token — the ping must be bare.
    expect(source).not.toContain('ONCELLCLAW_WEB_TOKEN');
  });
});
