/**
 * Wake-on-pending-outbound — the group cell's side of the 24/7 story.
 *
 * When the HOSTING cell pauses, its pump dies and staged replies sit in
 * this cell unpulled. The pump's own protocol gives us the detector: every
 * time the host's status exec stages a fresh outbound snapshot it rewrites
 * `.outbound.last` (cell-session-io.ts buildStatusCmd). So:
 *
 *   outbound.db mtime > .outbound.last mtime, for longer than the stale
 *   threshold  ⇒  the runner wrote rows and no pump has staged them
 *              ⇒  the host is asleep — ping its preview URL to wake it
 *                 (preview self-heal resumes the cell + service).
 *
 * The ping target is the claw's UNAUTHENTICATED /web/health: group cells
 * deliberately never hold the web bearer token, and a health probe is all
 * a wake needs. Pings are throttled and stop as soon as a pull happens
 * (.outbound.last catches up).
 *
 * Pure module (no bun imports) so the decision logic is unit-testable from
 * the host-side vitest suite, like stderr-tail.ts.
 */

/** How long staged-but-unpulled outbound may sit before we suspect a dead pump. */
export const WAKE_STALE_MS = 30_000;
/** Minimum spacing between wake pings. */
export const WAKE_PING_MIN_INTERVAL_MS = 60_000;

export interface WakePingInput {
  /** outbound.db mtime (ms); 0/undefined when the file doesn't exist. */
  outboundMtimeMs: number;
  /** .outbound.last mtime (ms); 0 when the host has never staged a pull. */
  lastStagedMtimeMs: number;
  nowMs: number;
  /** Last wake ping we sent (ms); 0 = never. */
  lastPingMs: number;
}

/**
 * Should the cell service ping the hosting claw's preview URL now?
 *
 *  - nothing to deliver (no outbound, or already staged) → no
 *  - fresh un-staged outbound (< stale threshold)        → no, pump may be
 *    mid-tick or a -journal is briefly blocking staging
 *  - stale un-staged outbound                            → yes, throttled
 */
export function shouldPingHostWake(input: WakePingInput): boolean {
  const { outboundMtimeMs, lastStagedMtimeMs, nowMs, lastPingMs } = input;
  if (!outboundMtimeMs) return false;
  if (lastStagedMtimeMs >= outboundMtimeMs) return false; // pump caught up
  // When did the wait start? A live pump stages within ~1.5s of any change,
  // so "pump silent since its last staging, with work pending" is the
  // signal. When it has NEVER staged, fall back to the outbound write time
  // (a runner mid-burst keeps advancing it — fine, bursts end).
  const pendingSinceMs = lastStagedMtimeMs > 0 ? lastStagedMtimeMs : outboundMtimeMs;
  if (nowMs - pendingSinceMs < WAKE_STALE_MS) return false;
  if (nowMs - lastPingMs < WAKE_PING_MIN_INTERVAL_MS) return false;
  return true;
}
