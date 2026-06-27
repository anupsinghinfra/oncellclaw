import { randomUUID } from 'crypto';

import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { routeInbound } from '../../router.js';
import type { MessagingGroup } from '../../types.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'messaging-group',
  plural: 'messaging-groups',
  table: 'messaging_groups',
  description:
    'Messaging group — one chat or channel on one platform (a Telegram DM, a Discord channel, a Slack thread root, an email address). Identity is the (channel_type, platform_id, instance) triple, which must be unique.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'channel_type',
      type: 'string',
      description:
        'Channel adapter type — matches the adapter registered by /add-<channel> (e.g. telegram, discord, slack, whatsapp).',
      required: true,
    },
    {
      name: 'platform_id',
      type: 'string',
      description:
        'Platform-specific chat ID. Format varies: Telegram chat ID, Discord channel snowflake, Slack channel ID, phone number, email address.',
      required: true,
    },
    {
      name: 'name',
      type: 'string',
      description: 'Display name. Often auto-populated by the channel adapter.',
      updatable: true,
    },
    {
      name: 'is_group',
      type: 'number',
      description: 'Multi-user group chat (1) or direct message (0). Affects session scoping.',
      default: 0,
      updatable: true,
    },
    {
      name: 'unknown_sender_policy',
      type: 'string',
      description:
        'What happens when an unrecognized sender posts. "strict" drops silently. "request_approval" sends an approval card to an admin. "public" allows anyone.',
      enum: ['strict', 'request_approval', 'public'],
      default: 'strict',
      updatable: true,
    },
    {
      name: 'denied_at',
      type: 'string',
      description:
        'Set when the owner explicitly denies registering this channel. While set, the router drops all messages silently without re-escalating. Cleared by any explicit wiring mutation.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // Generic create is replaced by the custom `create` below — the standard
  // INSERT can't default the NOT NULL `instance` column (it isn't in the
  // resource's column list) and isn't idempotent.
  operations: { list: 'open', get: 'open', update: 'approval', delete: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Create (or return the existing) messaging group. Idempotent on (channel_type, platform_id, instance); instance defaults to channel_type. Use --channel-type, --platform-id, optionally --instance, --name, --is-group, --unknown-sender-policy.',
      handler: async (args) => {
        const channelType = args.channel_type as string;
        const platformId = args.platform_id as string;
        if (!channelType || !platformId) {
          throw new Error('--channel-type and --platform-id are required');
        }
        const instance = (args.instance as string) ?? channelType;
        const existing = getMessagingGroupByPlatform(channelType, platformId, instance);
        if (existing) return existing;
        const group = {
          id: randomUUID(),
          channel_type: channelType,
          platform_id: platformId,
          instance,
          name: (args.name as string) ?? null,
          is_group: Number(args.is_group ?? 0),
          unknown_sender_policy: (args.unknown_sender_policy as string) ?? 'strict',
          denied_at: null,
          created_at: new Date().toISOString(),
        } as MessagingGroup;
        createMessagingGroup(group);
        return group;
      },
    },
    send: {
      access: 'approval',
      description:
        'Inject a message into a messaging group as if a sender posted it, waking the wired agent — used to send a welcome on first wire. Use --channel-type, --platform-id, --text, optionally --instance, --sender-id, --sender.',
      handler: async (args) => {
        const channelType = args.channel_type as string;
        const platformId = args.platform_id as string;
        const text = args.text as string;
        if (!channelType || !platformId || !text) {
          throw new Error('--channel-type, --platform-id and --text are required');
        }
        const instance = (args.instance as string) ?? channelType;
        const mg = getMessagingGroupByPlatform(channelType, platformId, instance);
        if (!mg) {
          throw new Error(`no messaging group for ${channelType} ${platformId} — create + wire it first`);
        }
        // Build the same InboundEvent the CLI admin transport (src/channels/cli.ts)
        // emits for a routed message, and route it in-process. The sender id should
        // be a wired user (e.g. the owner just granted) so the access gate passes.
        await routeInbound({
          channelType,
          instance,
          platformId,
          threadId: platformId,
          message: {
            id: `send-${randomUUID()}`,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            content: JSON.stringify({
              text,
              sender: (args.sender as string) ?? 'cli',
              senderId: (args.sender_id as string) ?? 'cli:local',
            }),
          },
        });
        return { sent: { channel_type: channelType, platform_id: platformId } };
      },
    },
  },
});
