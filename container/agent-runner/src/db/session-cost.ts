/**
 * Per-session run-cost ledger. Lives in outbound.db's session_state under a
 * single JSON key — the same container-owned store as the continuation, so
 * the host can read it read-only (e.g. /web/status) without a schema change
 * and the single-writer invariant holds: only the poll loop writes it.
 *
 * Deltas arrive from the poll loop, which reconciles the provider's
 * CUMULATIVE snapshots into per-turn increments (see poll-loop.ts). This
 * module just adds and persists.
 */
import { getOutboundDb } from './connection.js';

const RUN_COST_KEY = 'run_cost_totals';

export interface RunCostDelta {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface RunCostTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Number of provider turns that contributed to the totals. */
  turns: number;
}

const ZERO_TOTALS: RunCostTotals = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

function asFiniteNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Current totals — zeros when nothing has been recorded (or row malformed). */
export function getRunCostTotals(): RunCostTotals {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(RUN_COST_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { ...ZERO_TOTALS };
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    return {
      costUsd: asFiniteNumber(parsed.costUsd),
      inputTokens: asFiniteNumber(parsed.inputTokens),
      outputTokens: asFiniteNumber(parsed.outputTokens),
      cacheReadTokens: asFiniteNumber(parsed.cacheReadTokens),
      cacheCreationTokens: asFiniteNumber(parsed.cacheCreationTokens),
      turns: asFiniteNumber(parsed.turns),
    };
  } catch {
    return { ...ZERO_TOTALS }; // malformed row — start a fresh ledger
  }
}

/** Add one turn's delta to the ledger and persist. Returns the new totals. */
export function recordRunCost(delta: RunCostDelta): RunCostTotals {
  const totals = getRunCostTotals();
  const next: RunCostTotals = {
    costUsd: totals.costUsd + asFiniteNumber(delta.costUsd),
    inputTokens: totals.inputTokens + asFiniteNumber(delta.inputTokens),
    outputTokens: totals.outputTokens + asFiniteNumber(delta.outputTokens),
    cacheReadTokens: totals.cacheReadTokens + asFiniteNumber(delta.cacheReadTokens),
    cacheCreationTokens: totals.cacheCreationTokens + asFiniteNumber(delta.cacheCreationTokens),
    turns: totals.turns + 1,
  };
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(RUN_COST_KEY, JSON.stringify(next), new Date().toISOString());
  return next;
}
