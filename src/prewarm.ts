/**
 * Cell pre-warm — pay the bootstrap cost at boot, not on the first message.
 *
 * On a fresh hosted claw the default group's cell bootstrap (bun + Claude
 * Code install) used to run lazily when the first message woke the cell —
 * so the user's very first message ate the whole install (minutes). This
 * fires the EXACT same wake path a message uses (wakeContainer →
 * bootstrap + runner service start; no synthetic message — an idle runner
 * just polls an empty inbound.db), in the background, right after the host
 * is live. By the time a human types their first message, the brain is
 * already installed.
 *
 * Guarantees:
 *  - Fire-and-forget: never blocks boot or /web/health readiness, never
 *    throws (a pre-warm failure means the first message bootstraps lazily,
 *    exactly as before — host-sweep retry semantics unchanged).
 *  - Idempotent + cheap on warm restarts: wakeContainer's own guards skip
 *    live runners, and the cell-side bootstrap marker fast-path makes a
 *    re-wake of an already-bootstrapped cell near-free (it IS the same
 *    path a warm message-wake takes).
 *  - Throttled: skipped entirely when a runner service is already live for
 *    the session (process-local check, same one the router relies on).
 *  - Scoped: only the default web group (ONCELLCLAW_GROUP, the group
 *    cloud-start provisions). Installs without one (self-host without the
 *    web provision) skip silently — their groups wake on demand as always.
 */
import { isContainerRunning, wakeContainer } from './container-runner.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { log } from './log.js';
import { resolveSession } from './session-manager.js';

/** Same literal the web channel registers under — imported as a literal so
 *  this module never side-effect-loads the channel barrel. */
const WEB_CHANNEL_TYPE = 'web';
const DEFAULT_GROUP = 'assistant';

export function prewarmDefaultGroupCell(): void {
  try {
    const slug = (process.env.ONCELLCLAW_GROUP || DEFAULT_GROUP).trim();
    const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, slug);
    if (!mg) {
      log.debug('Pre-warm skipped — no provisioned web group', { slug });
      return;
    }
    const wirings = getMessagingGroupAgents(mg.id);
    if (wirings.length === 0) {
      log.debug('Pre-warm skipped — web group has no wired agent', { slug });
      return;
    }
    for (const wiring of wirings) {
      const { session } = resolveSession(wiring.agent_group_id, mg.id, null, wiring.session_mode ?? 'shared');
      if (isContainerRunning(session.id)) {
        log.debug('Pre-warm skipped — runner already live', { sessionId: session.id });
        continue;
      }
      log.info('Pre-warming agent cell for the default group', { slug, sessionId: session.id });
      void wakeContainer(session).then((ok) => {
        if (ok) log.info('Pre-warm complete — cell bootstrapped and runner polling', { sessionId: session.id });
        else log.warn('Pre-warm wake declined — first message will bootstrap lazily', { sessionId: session.id });
      });
    }
  } catch (err) {
    // Strictly best-effort: lazy first-message bootstrap remains the fallback.
    log.warn('Pre-warm failed — first message will bootstrap lazily', { err });
  }
}
