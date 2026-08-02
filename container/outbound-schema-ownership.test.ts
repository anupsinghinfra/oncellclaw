/**
 * Structural guarantee: the agent-runner owns outbound.db's schema.
 *
 * On the docker path the host pre-creates the session DB schemas and the
 * bind mount shares the files; on the OnCell runtime the cell-side
 * outbound.db is a fresh file only the runner ever touches. The runner's
 * connection layer must therefore create its full schema on open — a bare
 * .db file being fatal is exactly the crash-loop this pins against
 * ("no such table: processing_ack", live on clawg cells).
 *
 * Structural (source-level) because the runner's real tests run under Bun
 * (bun:sqlite); this keeps the invariant enforced from the vitest suite.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

describe('agent-runner outbound.db schema ownership', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'container', 'agent-runner', 'src', 'db', 'connection.ts'),
    'utf-8',
  );

  it('getOutboundDb ensures every outbound table on open', () => {
    for (const table of ['messages_out', 'processing_ack', 'session_state', 'container_state']) {
      expect(source).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
  });

  it('runner outbound schema stays column-identical to the host OUTBOUND_SCHEMA', async () => {
    const { OUTBOUND_SCHEMA } = await import('../src/db/schema.js');
    // Compare the messages_out column lists (name order) between both sides.
    const columns = (schema: string): string[] => {
      const match = /CREATE TABLE IF NOT EXISTS messages_out \(([^;]+?)\);/s.exec(schema);
      if (!match) return [];
      return match[1]!
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0]!)
        .filter((name) => name && !name.startsWith('--') && !name.startsWith(')'));
    };
    expect(columns(source)).toEqual(columns(OUTBOUND_SCHEMA));
    expect(columns(source).length).toBeGreaterThan(0);
  });
});

describe('claude CLI location — bootstrap and runner agree', () => {
  it('the bootstrap installs claude exactly where the cell-mode runner resolves it', async () => {
    const { buildServiceBootstrapScript } = await import('../src/cell-runner.js');
    const script = buildServiceBootstrapScript('2.1.197', 'm', '/ws');
    // Bootstrap side: npm prefix $HOME/.claw-tools → shim at .claw-tools/bin.
    expect(script).toContain('TOOLS="$HOME/.claw-tools"');
    expect(script).toMatch(/npm install -g --prefix "\$TOOLS" .* @anthropic-ai\/claude-code/);

    // Runner side: cell mode resolves the same canonical location; docker
    // keeps the image path.
    const providerSrc = fs.readFileSync(
      path.join(process.cwd(), 'container', 'agent-runner', 'src', 'providers', 'claude.ts'),
      'utf-8',
    );
    expect(providerSrc).toContain("path.join(env.HOME || '/workspace', '.claw-tools', 'bin', 'claude')");
    expect(providerSrc).toContain('pathToClaudeCodeExecutable: claudeExecutablePath()');
    expect(providerSrc).toContain("return '/pnpm/claude'");
  });
});
