import { randomUUID } from 'crypto';

import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import type { MessagingGroupAgent } from '../../types.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'wiring',
  plural: 'wirings',
  table: 'messaging_group_agents',
  description:
    'Wiring — connects a messaging group to an agent group. Determines which agent handles messages from which chat. The same messaging group can be wired to multiple agents; the same agent can be wired to multiple messaging groups.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'The chat/channel to route from. References messaging_groups.id.',
      required: true,
    },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'The agent that handles messages. References agent_groups.id.',
      required: true,
    },
    {
      name: 'engage_mode',
      type: 'string',
      description:
        'When the agent engages. "mention" — only when @mentioned or in DMs. "mention-sticky" — once mentioned in a thread, the agent subscribes and responds to all subsequent messages in that thread without needing further mentions. "pattern" — matches every message against engage_pattern regex.',
      enum: ['pattern', 'mention', 'mention-sticky'],
      default: 'mention',
      updatable: true,
    },
    {
      name: 'engage_pattern',
      type: 'string',
      description:
        'Regex for engage_mode=pattern. Required when mode is pattern. Use "." to match every message (always-on). Ignored for mention modes.',
      updatable: true,
    },
    {
      name: 'sender_scope',
      type: 'string',
      description:
        '"all" — any sender (subject to unknown_sender_policy). "known" — only users with a role or membership in this agent group.',
      enum: ['all', 'known'],
      default: 'all',
      updatable: true,
    },
    {
      name: 'ignored_message_policy',
      type: 'string',
      description:
        'What happens to messages that don\'t trigger engagement. "drop" — agent never sees them. "accumulate" — stored as background context (trigger=0) so the agent has prior context when eventually triggered.',
      enum: ['drop', 'accumulate'],
      default: 'drop',
      updatable: true,
    },
    {
      name: 'session_mode',
      type: 'string',
      description:
        '"shared" — one session per (agent, messaging group). "per-thread" — separate session per thread/topic. "agent-shared" — one session across all messaging groups wired to this agent. Note: threaded adapters in group chats force per-thread regardless of this setting.',
      enum: ['shared', 'per-thread', 'agent-shared'],
      default: 'shared',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // Generic create is replaced by the custom `create` below — it resolves
  // natural keys (so a skill can wire by channel/platform + agent-group folder
  // without first looking up synthetic ids) and is idempotent on the pair.
  operations: { list: 'open', get: 'open', update: 'approval', delete: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Wire a messaging group to an agent group. Identify the messaging group by --messaging-group-id OR --channel-type + --platform-id (+ --instance); identify the agent by --agent-group-id OR --agent-group <folder>. Idempotent on (messaging group, agent group). Engagement flags: --engage-mode, --engage-pattern, --session-mode, --sender-scope, --ignored-message-policy.',
      handler: async (args) => {
        // Resolve the messaging group.
        let mgId = args.messaging_group_id as string | undefined;
        if (!mgId) {
          const channelType = args.channel_type as string;
          const platformId = args.platform_id as string;
          if (!channelType || !platformId) {
            throw new Error('provide --messaging-group-id, or --channel-type and --platform-id to resolve it');
          }
          const mg = getMessagingGroupByPlatform(channelType, platformId, (args.instance as string) ?? channelType);
          if (!mg) throw new Error(`no messaging group for ${channelType} ${platformId} — create it first`);
          mgId = mg.id;
        }

        // Resolve the agent group (by id or by folder).
        let agId = args.agent_group_id as string | undefined;
        if (!agId) {
          const ref = args.agent_group as string;
          if (!ref) throw new Error('provide --agent-group-id or --agent-group <folder>');
          const ag = getAgentGroup(ref) ?? getAgentGroupByFolder(ref);
          if (!ag) throw new Error(`no agent group "${ref}" (by id or folder)`);
          agId = ag.id;
        }

        // Idempotent: a wiring for this pair already exists → return it.
        const existing = getMessagingGroupAgentByPair(mgId, agId);
        if (existing) return existing;

        const mga = {
          id: randomUUID(),
          messaging_group_id: mgId,
          agent_group_id: agId,
          engage_mode: (args.engage_mode as string) ?? 'mention',
          engage_pattern: (args.engage_pattern as string) ?? null,
          sender_scope: (args.sender_scope as string) ?? 'all',
          ignored_message_policy: (args.ignored_message_policy as string) ?? 'drop',
          session_mode: (args.session_mode as string) ?? 'shared',
          priority: Number(args.priority ?? 0),
          created_at: new Date().toISOString(),
        } as MessagingGroupAgent;
        createMessagingGroupAgent(mga);
        return mga;
      },
    },
  },
});
