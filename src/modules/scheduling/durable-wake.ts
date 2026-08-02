/**
 * Durable scheduler wakes on the OnCell runtime.
 *
 * THE PROBLEM: on hosted, the claw host process runs as a cell service and
 * PAUSES with its cell after the idle timeout. `setTimeout`-based
 * scheduling (the sweep loop) stops with it, so a task due at 9am never
 * fires until something else wakes the cell. Laptop/docker installs are
 * unaffected — their host process never pauses.
 *
 * THE BRIDGE: whenever the earliest due time across all sessions changes,
 * register ONE wake for this claw's OWN hosting cell with the platform:
 *
 *   PUT    /api/v1/cells/{cell_id}/wake   {"wake_at": "<ISO8601>"}   (upsert)
 *   DELETE /api/v1/cells/{cell_id}/wake                              (clear)
 *
 * At wake_at the platform resumes the paused cell and starts its recorded
 * service; the freshly booted claw's sweep then finds the due task and
 * wakes the agent — normal machinery from there. One wake per claw (the
 * earliest due time) is sufficient: after it fires, boot re-registration
 * covers the next one.
 *
 * PLATFORM STATUS: this endpoint does not exist yet (the cells API has
 * immediate `POST /resume` only; the park/wake ledger is agent-run-facing).
 * The registrar therefore treats 404/405 as "platform not ready" — logged
 * once, never thrown — so this seam is inert-but-armed and starts working
 * the moment the endpoint ships, with no OSS change.
 *
 * POSTURE: hosting-cell only. The platform supervisor injects
 * ONCELL_CELL_ID into every cell service's env — its presence (plus an API
 * key) IS the "I am a hosted claw" signal. Absent → every call here is a
 * no-op and timers carry the laptop/docker path as they always have.
 */
import fs from 'fs';

import { ONCELL_API_KEY, ONCELL_API_URL } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';

const DEFAULT_API_URL = 'https://api.oncell.ai';
const REQUEST_TIMEOUT_MS = 15_000;

/** Registration surface — injectable so tests never touch the network. */
export interface CellWakeRegistrar {
  scheduleWake(wakeAtIso: string): Promise<void>;
  clearWake(): Promise<void>;
}

let injectedRegistrar: CellWakeRegistrar | undefined;
/** Last value successfully registered ('' = cleared/none). Dedup gate. */
let registeredWakeAt: string | null = null;
let warnedPlatformGap = false;

/** Test seams. */
export function _setWakeRegistrarForTesting(registrar: CellWakeRegistrar | undefined): void {
  injectedRegistrar = registrar;
  registeredWakeAt = null;
  warnedPlatformGap = false;
}
export function _registeredWakeAtForTesting(): string | null {
  return registeredWakeAt;
}

/** Hosted-claw posture: running as a cell service, with an API key to act. */
export function isHostedClawPosture(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ONCELL_CELL_ID && (ONCELL_API_KEY || env.ONCELL_API_KEY));
}

function defaultRegistrar(): CellWakeRegistrar {
  const cellId = process.env.ONCELL_CELL_ID ?? '';
  const apiKey = ONCELL_API_KEY || process.env.ONCELL_API_KEY || '';
  const base = (ONCELL_API_URL || process.env.ONCELL_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
  const url = `${base}/api/v1/cells/${encodeURIComponent(cellId)}/wake`;

  const call = async (method: 'PUT' | 'DELETE', body?: unknown): Promise<void> => {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 405) {
      // Platform gap — the wake endpoint hasn't shipped. Armed, not broken.
      if (!warnedPlatformGap) {
        warnedPlatformGap = true;
        log.warn(
          'OnCell cell-wake endpoint not available yet — scheduled tasks will not fire while this cell is paused',
          {
            url,
            status: response.status,
          },
        );
      }
      return;
    }
    if (!response.ok) {
      throw new Error(`cell wake ${method} failed: HTTP ${response.status}`);
    }
  };

  return {
    scheduleWake: (wakeAtIso) => call('PUT', { wake_at: wakeAtIso }),
    clearWake: () => call('DELETE'),
  };
}

/**
 * Earliest FUTURE due time across every active session's pending trigger
 * rows, as an ISO string — or null when nothing is scheduled. Rows already
 * due (process_after <= now) don't need a wake: the process is clearly
 * awake to be running this, and the sweep handles them this tick.
 */
export function computeNextDueTime(nowIso: string = new Date().toISOString()): string | null {
  let earliest: string | null = null;
  for (const session of getActiveSessions()) {
    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) continue;
    if (!fs.existsSync(inboundDbPath(agentGroup.id, session.id))) continue;
    try {
      const db = openInboundDb(agentGroup.id, session.id);
      try {
        const row = db
          .prepare(
            `SELECT MIN(process_after) AS next FROM messages_in
              WHERE status = 'pending' AND trigger = 1
                AND process_after IS NOT NULL AND process_after > ?`,
          )
          .get(nowIso) as { next: string | null };
        if (row.next && (earliest === null || row.next < earliest)) earliest = row.next;
      } finally {
        db.close();
      }
    } catch {
      // bare/missing session DB — nothing scheduled there
    }
  }
  return earliest;
}

/**
 * Reconcile the platform wake with the DB's next due time. Called from the
 * host sweep every tick (cheap: deduped on the last registered value) and
 * from boot via the first tick — which IS the boot re-registration: a
 * fresh process has `registeredWakeAt === null`, so the first tick always
 * re-PUTs (or clears) from the DB regardless of what a previous run left.
 */
export async function refreshDurableWake(): Promise<void> {
  if (!injectedRegistrar && !isHostedClawPosture()) return;

  const next = computeNextDueTime() ?? '';
  if (registeredWakeAt === next) return; // unchanged — nothing to do

  const registrar = injectedRegistrar ?? defaultRegistrar();
  try {
    if (next === '') {
      // Only clear when we (or a previous run) may have registered one.
      await registrar.clearWake();
    } else {
      await registrar.scheduleWake(next);
    }
    registeredWakeAt = next;
    log.info('Durable cell wake reconciled', { wakeAt: next === '' ? null : next });
  } catch (err) {
    // Leave registeredWakeAt unchanged — the next sweep tick retries.
    log.warn('Durable cell wake reconcile failed — will retry next sweep', { err });
  }
}
