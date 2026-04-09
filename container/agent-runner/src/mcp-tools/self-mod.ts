/**
 * Self-modification MCP tools: install_packages, add_mcp_server, request_rebuild.
 *
 * These tools request changes to the agent's container configuration.
 * install_packages and request_rebuild require admin approval.
 * add_mcp_server takes effect on next container restart without approval.
 */
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForResponse(requestId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = findQuestionResponse(requestId);
    if (response) {
      const parsed = JSON.parse(response.content);
      markCompleted([response.id]);
      if (parsed.status === 'success') {
        return ok(JSON.stringify(parsed.result || 'Success'));
      }
      return err(parsed.result?.error || parsed.selectedOption || 'Request denied');
    }
    await sleep(2000);
  }
  return err(`Request timed out after ${timeoutMs / 1000}s`);
}

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Request installation of system (apt) or Node.js (npm) packages in the container. Requires admin approval. Takes effect after container rebuild.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: { type: 'array', items: { type: 'string' }, description: 'apt packages to install' },
        npm: { type: 'array', items: { type: 'string' }, description: 'npm packages to install globally' },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        requestId,
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return await pollForResponse(requestId, 300_000);
  },
};

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      "Add an MCP server to this agent's configuration. Takes effect on next container restart (no rebuild needed, no approval required).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Command to run the MCP server' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        env: { type: 'object', description: 'Environment variables for the server' },
      },
      required: ['name', 'command'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const command = args.command as string;
    if (!name || !command) return err('name and command are required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        requestId,
        name,
        command,
        args: (args.args as string[]) || [],
        env: (args.env as Record<string, string>) || {},
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${command})`);
    return await pollForResponse(requestId, 30_000);
  },
};

export const requestRebuild: McpToolDefinition = {
  tool: {
    name: 'request_rebuild',
    description:
      'Request a container rebuild to apply pending package installations. Requires admin approval. The current container will be stopped and restarted with the new image.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'Why the rebuild is needed' },
      },
    },
  },
  async handler(args) {
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_rebuild',
        requestId,
        reason: (args.reason as string) || '',
      }),
    });

    log(`request_rebuild: ${requestId}`);
    return await pollForResponse(requestId, 300_000);
  },
};

export const selfModTools: McpToolDefinition[] = [installPackages, addMcpServer, requestRebuild];
