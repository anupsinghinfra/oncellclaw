/**
 * Builder-agent MCP tools: request_dev_changes (for originating agents) and
 * request_swap (for dev agents).
 *
 * Both are fire-and-forget: the tool writes a system action row to
 * messages_out and returns immediately. The host processes the request and
 * notifies the agent via a chat message when complete.
 *
 * See `src/builder-agent/handlers.ts` on the host for the receive side.
 */
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

export const createDevAgent: McpToolDefinition = {
  tool: {
    name: 'create_dev_agent',
    description:
      "Spawn a dev agent to edit NanoClaw's own source code — new built-in MCP tools, runner/host bug fixes, new skill files, Dockerfile/package.json/migration changes, writing a new MCP server from scratch. Heaviest self-mod path: new container, git worktree, admin approval, swap-and-restart.\n\nPrefer lighter tools when they fit: `install_packages` (new apt/npm dep in your container), `add_mcp_server` (wire an EXISTING third-party server you can invoke by command+args), `trigger_credential_collection` (API key/token), `create_agent` (long-lived companion sub-agent), `request_rebuild` (rebuild after approved config change).\n\nTwo-step flow: (1) call with just a name — does NOT start work, (2) after the 'ready' notification, send task details via `<message to=\"<name>\">`. Do not include task details in this call.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            'Short descriptive destination name for the dev agent (e.g. "dev-welcome-message", "dev-fix-typo"). Becomes the local destination you address it by. Tearing down a previous dev agent for this group is automatic on create.',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = (args.name as string)?.trim();
    if (!name) return err('name is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_dev_agent',
        requestId,
        name,
      }),
    });

    log(`create_dev_agent: ${requestId} → "${name}"`);
    return ok(
      `Dev agent creation submitted. You will be notified when it is ready. When you see that notification, send it a message with <message to="${name}">...task details here...</message> to kick off the work. The dev agent does NOT start working until you message it.`,
    );
  },
};

export const requestSwap: McpToolDefinition = {
  tool: {
    name: 'request_swap',
    description:
      'From a dev agent: submit your committed worktree changes for admin approval. The summaries become the human-readable portion of the approval card. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        overall_summary: {
          type: 'string',
          description:
            'Overall summary of the code change: what it does, why, and any risk. This is what the admin/owner reads first, so be concrete.',
        },
        per_file_summaries: {
          type: 'object',
          description:
            'Map of relative worktree path → one-sentence explanation of what changed in that file. Every changed file should have an entry.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['overall_summary', 'per_file_summaries'],
    },
  },
  async handler(args) {
    const overall = (args.overall_summary as string)?.trim();
    const perFile = args.per_file_summaries as Record<string, string> | undefined;
    if (!overall) return err('overall_summary is required');
    if (!perFile || Object.keys(perFile).length === 0) return err('per_file_summaries is required and must be non-empty');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_swap',
        overallSummary: overall,
        perFileSummaries: perFile,
      }),
    });

    log(`request_swap: ${requestId} → ${Object.keys(perFile).length} file(s)`);
    return ok(
      `Code change submitted. The host will classify the diff and route it for admin/owner approval. You will be notified once classification completes.`,
    );
  },
};

export const builderAgentTools: McpToolDefinition[] = [createDevAgent, requestSwap];
