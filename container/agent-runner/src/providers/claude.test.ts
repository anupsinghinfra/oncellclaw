import { describe, it, expect } from 'bun:test';

import { ClaudeProvider } from './claude.js';

describe('ClaudeProvider.isAuthRequired', () => {
  const provider = new ClaudeProvider();

  it('matches the "Not logged in" banner', () => {
    expect(provider.isAuthRequired('Not logged in · Please run /login')).toBe(true);
  });

  it('matches the "Invalid API key" banner', () => {
    expect(provider.isAuthRequired('Invalid API key · Please run /login')).toBe(true);
  });

  it('matches with trailing content after the banner', () => {
    expect(provider.isAuthRequired('Not logged in · Please run /login\n\nstack trace …')).toBe(true);
  });

  it('does not match when the agent quotes the phrase mid-sentence', () => {
    const quoted = "The error 'Invalid API key · Please run /login' means your auth has expired.";
    expect(provider.isAuthRequired(quoted)).toBe(false);
  });

  it('does not match when the agent leads its reply with the phrase in prose', () => {
    const prose = '"Not logged in · Please run /login" is a Claude Code error.';
    expect(provider.isAuthRequired(prose)).toBe(false);
  });

  it('does not match a different separator (defensive against typos in agent output)', () => {
    expect(provider.isAuthRequired('Not logged in - Please run /login')).toBe(false);
  });

  it('does not match unrelated text', () => {
    expect(provider.isAuthRequired('Tool execution failed: timeout')).toBe(false);
  });
});
