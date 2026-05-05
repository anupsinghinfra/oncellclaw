/**
 * CLI MCP tool — lets the container agent invoke host CLI commands.
 *
 * Follows the ask_user_question blocking pattern: writes a system message
 * to outbound.db, polls inbound.db for the response.
 */
import { findCliResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const ncCommand: McpToolDefinition = {
  tool: {
    name: 'nc',
    description:
      'Run a NanoClaw CLI command on the host. Returns the command result as JSON. Use `nc list-groups` to see available agent groups. Run with command "help" to list all available commands.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Command name (e.g. "list-groups")' },
        args: {
          type: 'object',
          description: 'Command arguments (command-specific)',
          additionalProperties: true,
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['command'],
    },
  },
  async handler(args) {
    const command = args.command as string;
    const commandArgs = (args.args as Record<string, unknown>) ?? {};
    const timeout = ((args.timeout as number) || 30) * 1000;

    if (!command) {
      return { content: [{ type: 'text' as const, text: 'Error: command is required' }], isError: true };
    }

    const requestId = generateId();

    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'cli_request',
        requestId,
        command,
        args: commandArgs,
      }),
    });

    log(`nc: ${requestId} → ${command} ${JSON.stringify(commandArgs)}`);

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = findCliResponse(requestId);
      if (response) {
        markCompleted([response.id]);
        const parsed = JSON.parse(response.content);
        const frame = parsed.frame;

        if (frame.ok) {
          log(`nc response: ${requestId} → ok`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(frame.data, null, 2) }] };
        } else {
          log(`nc response: ${requestId} → error: ${frame.error.message}`);
          return {
            content: [{ type: 'text' as const, text: `Error (${frame.error.code}): ${frame.error.message}` }],
            isError: true,
          };
        }
      }
      await sleep(500);
    }

    log(`nc timeout: ${requestId}`);
    return {
      content: [{ type: 'text' as const, text: `CLI command timed out after ${timeout / 1000}s` }],
      isError: true,
    };
  },
};

registerTools([ncCommand]);
