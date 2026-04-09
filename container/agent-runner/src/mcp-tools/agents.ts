/**
 * Agent-to-agent MCP tools: send_to_agent, create_agent.
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

export const sendToAgent: McpToolDefinition = {
  tool: {
    name: 'send_to_agent',
    description: 'Send a message to another agent group.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentGroupId: { type: 'string', description: 'Target agent group ID' },
        text: { type: 'string', description: 'Message content' },
        sessionId: { type: 'string', description: 'Target specific session (optional)' },
      },
      required: ['agentGroupId', 'text'],
    },
  },
  async handler(args) {
    const agentGroupId = args.agentGroupId as string;
    const text = args.text as string;
    if (!agentGroupId || !text) return err('agentGroupId and text are required');

    const id = generateId();

    writeMessageOut({
      id,
      kind: 'chat',
      channel_type: 'agent',
      platform_id: agentGroupId,
      thread_id: (args.sessionId as string) || null,
      content: JSON.stringify({ text }),
    });

    log(`send_to_agent: ${id} → ${agentGroupId}`);
    return ok(`Message sent to agent ${agentGroupId} (id: ${id})`);
  },
};

export const createAgent: McpToolDefinition = {
  tool: {
    name: 'create_agent',
    description: 'Create a new agent group dynamically. Returns the new agent group ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Agent display name' },
        instructions: { type: 'string', description: 'CLAUDE.md content (agent instructions/personality)' },
        folder: { type: 'string', description: 'Folder name (default: auto-generated from name)' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');

    const requestId = generateId();

    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_agent',
        requestId,
        name,
        instructions: (args.instructions as string) || null,
        folder: (args.folder as string) || null,
      }),
    });

    log(`create_agent: ${requestId} → "${name}"`);

    // Poll for host response
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const response = findQuestionResponse(requestId);
      if (response) {
        const parsed = JSON.parse(response.content);
        markCompleted([response.id]);
        if (parsed.status === 'success') {
          return ok(`Agent created: ${parsed.result.agentGroupId} (name: ${parsed.result.name}, folder: ${parsed.result.folder})`);
        }
        return err(parsed.result?.error || 'Failed to create agent');
      }
      await sleep(1000);
    }
    return err('Timed out waiting for agent creation response');
  },
};

export const agentTools: McpToolDefinition[] = [sendToAgent, createAgent];
