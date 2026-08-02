/**
 * Agent runtime selection — oncellclaw runs agents either in OnCell cells
 * (the fork's default) or in local Docker containers (upstream NanoClaw
 * behavior, fully preserved).
 *
 * Selection matrix (first match wins):
 *
 *   ONCELLCLAW_RUNTIME=docker   → docker (explicit opt-out, even with a key)
 *   ONCELLCLAW_RUNTIME=oncell   → oncell (fails later if ONCELL_API_KEY absent)
 *   ONCELL_API_KEY set          → oncell
 *   otherwise                   → docker (the fork still works fully local)
 *
 * Pure so the matrix is unit-testable; config.ts computes the effective
 * runtime once at startup from .env/process.env.
 */

export type RuntimeKind = 'oncell' | 'docker';

export interface RuntimeSelectionInput {
  /** ONCELLCLAW_RUNTIME — explicit override, 'oncell' or 'docker'. */
  runtimeOverride?: string;
  /** ONCELL_API_KEY — presence implies oncell when no override is given. */
  oncellApiKey?: string;
}

export function resolveRuntimeKind(input: RuntimeSelectionInput): RuntimeKind {
  const override = input.runtimeOverride?.trim().toLowerCase();
  if (override === 'docker') return 'docker';
  if (override === 'oncell') return 'oncell';
  return input.oncellApiKey ? 'oncell' : 'docker';
}
