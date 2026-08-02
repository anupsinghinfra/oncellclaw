import { describe, it, expect } from 'bun:test';

import { extractResultCost } from './claude.js';

describe('extractResultCost', () => {
  it('extracts cost and token usage from an SDK result message', () => {
    const cost = extractResultCost({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.1234,
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 150,
      },
    });
    expect(cost).toEqual({
      costUsd: 0.1234,
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 9000,
      cacheCreationTokens: 150,
    });
  });

  it('keeps partial data when fields are missing', () => {
    const cost = extractResultCost({ type: 'result', total_cost_usd: 0.02 });
    expect(cost).toEqual({ costUsd: 0.02 });
  });

  it('returns undefined when nothing usable is present', () => {
    expect(extractResultCost({ type: 'result', subtype: 'success' })).toBeUndefined();
    expect(extractResultCost({})).toBeUndefined();
  });

  it('never propagates non-finite or non-numeric values into the ledger', () => {
    const cost = extractResultCost({
      total_cost_usd: 'free',
      usage: { input_tokens: NaN, output_tokens: Infinity, cache_read_input_tokens: 5 },
    });
    expect(cost).toEqual({ cacheReadTokens: 5 });
  });
});
