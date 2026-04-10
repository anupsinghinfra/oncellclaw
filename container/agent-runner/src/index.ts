/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config:
 *   - SESSION_INBOUND_DB_PATH:  path to host-owned inbound DB (default: /workspace/inbound.db)
 *   - SESSION_OUTBOUND_DB_PATH: path to container-owned outbound DB (default: /workspace/outbound.db)
 *   - SESSION_HEARTBEAT_PATH:   heartbeat file path (default: /workspace/.heartbeat)
 *   - AGENT_PROVIDER: 'claude' | 'mock' (default: claude)
 *   - NANOCLAW_ASSISTANT_NAME: assistant name for transcript archiving
 *   - NANOCLAW_ADMIN_USER_ID: admin user ID for permission checks
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, skills, working files)
 *     .claude/          ← Claude SDK session data
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildSystemPromptAddendum, loadDestinations } from './destinations.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';
const GLOBAL_CLAUDE_MD = '/workspace/global/CLAUDE.md';

async function main(): Promise<void> {
  const providerName = (process.env.AGENT_PROVIDER || 'claude') as ProviderName;
  const assistantName = process.env.NANOCLAW_ASSISTANT_NAME;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  const provider = createProvider(providerName, { assistantName });

  // Load destination map (written by host on every wake)
  loadDestinations();

  // Load global CLAUDE.md as additional system context, then append destinations addendum
  let systemPrompt: string | undefined;
  if (fs.existsSync(GLOBAL_CLAUDE_MD)) {
    systemPrompt = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf-8');
    log('Loaded global CLAUDE.md');
  }
  const addendum = buildSystemPromptAddendum();
  systemPrompt = systemPrompt ? `${systemPrompt}\n\n${addendum}` : addendum;

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.js');

  // SDK env
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  // Build MCP servers config: nanoclaw built-in + any additional from host
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        SESSION_INBOUND_DB_PATH: process.env.SESSION_INBOUND_DB_PATH || '/workspace/inbound.db',
        SESSION_OUTBOUND_DB_PATH: process.env.SESSION_OUTBOUND_DB_PATH || '/workspace/outbound.db',
        SESSION_HEARTBEAT_PATH: process.env.SESSION_HEARTBEAT_PATH || '/workspace/.heartbeat',
      },
    },
  };

  // Merge additional MCP servers from host configuration
  if (process.env.NANOCLAW_MCP_SERVERS) {
    try {
      const additional = JSON.parse(process.env.NANOCLAW_MCP_SERVERS) as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      for (const [name, config] of Object.entries(additional)) {
        mcpServers[name] = config;
        log(`Additional MCP server: ${name} (${config.command})`);
      }
    } catch (e) {
      log(`Failed to parse NANOCLAW_MCP_SERVERS: ${e}`);
    }
  }

  await runPollLoop({
    provider,
    cwd: CWD,
    mcpServers,
    systemPrompt,
    env,
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
