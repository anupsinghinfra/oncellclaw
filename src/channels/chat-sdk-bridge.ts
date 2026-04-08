/**
 * Chat SDK bridge — wraps a Chat SDK adapter + Chat instance
 * to conform to the NanoClaw ChannelAdapter interface.
 *
 * Used by Discord, Slack, and other Chat SDK-supported platforms.
 */
import { Chat, type Adapter, type ConcurrencyStrategy, type Message as ChatMessage } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';

import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, ConversationConfig, InboundMessage } from './adapter.js';

/** Adapter with optional gateway support (e.g., Discord). */
interface GatewayAdapter extends Adapter {
  startGatewayListener?(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<Response>;
}

export interface ChatSdkBridgeConfig {
  adapter: GatewayAdapter;
  concurrency?: ConcurrencyStrategy;
}

export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  const { adapter } = config;
  let chat: Chat;
  let state: ReturnType<typeof createMemoryState>;
  let setupConfig: ChannelSetup;
  let conversations: Map<string, ConversationConfig>;
  let gatewayAbort: AbortController | null = null;

  function buildConversationMap(configs: ConversationConfig[]): Map<string, ConversationConfig> {
    const map = new Map<string, ConversationConfig>();
    for (const conv of configs) {
      map.set(conv.platformId, conv);
    }
    return map;
  }

  function messageToInbound(message: ChatMessage): InboundMessage {
    return {
      id: message.id,
      kind: 'chat-sdk',
      content: message.toJSON(),
      timestamp: message.metadata.dateSent.toISOString(),
    };
  }

  return {
    name: adapter.name,
    channelType: adapter.name,

    async setup(hostConfig: ChannelSetup) {
      setupConfig = hostConfig;
      conversations = buildConversationMap(hostConfig.conversations);

      state = createMemoryState();

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        userName: adapter.userName || 'NanoClaw',
        concurrency: config.concurrency ?? 'concurrent',
        state,
        logger: 'silent',
      });

      // Subscribed threads — forward all messages
      chat.onSubscribedMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        setupConfig.onInbound(channelId, thread.id, messageToInbound(message));
      });

      // @mention in unsubscribed thread — forward + subscribe
      chat.onNewMention(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        setupConfig.onInbound(channelId, thread.id, messageToInbound(message));
        await thread.subscribe();
      });

      // DMs — always forward + subscribe
      chat.onDirectMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        setupConfig.onInbound(channelId, null, messageToInbound(message));
        await thread.subscribe();
      });

      await chat.initialize();

      // Subscribe registered conversations (after initialize connects state)
      for (const conv of hostConfig.conversations) {
        if (conv.agentGroupId) {
          const threadId = adapter.encodeThreadId({ guildId: '', channelId: conv.platformId } as never);
          await state.subscribe(threadId);
        }
      }

      // Start Gateway listener for adapters that support it (e.g., Discord)
      if (adapter.startGatewayListener) {
        gatewayAbort = new AbortController();
        const startGateway = () => {
          if (gatewayAbort?.signal.aborted) return;
          // Capture the long-running listener promise via waitUntil
          let listenerPromise: Promise<unknown> | undefined;
          adapter
            .startGatewayListener!(
              { waitUntil: (p: Promise<unknown>) => { listenerPromise = p; } },
              24 * 60 * 60 * 1000,
              gatewayAbort!.signal,
            )
            .then(() => {
              // startGatewayListener resolves immediately with a Response;
              // the actual work is in the listenerPromise passed to waitUntil
              if (listenerPromise) {
                listenerPromise
                  .then(() => {
                    if (!gatewayAbort?.signal.aborted) {
                      log.info('Gateway listener expired, restarting', { adapter: adapter.name });
                      startGateway();
                    }
                  })
                  .catch((err) => {
                    if (!gatewayAbort?.signal.aborted) {
                      log.error('Gateway listener error, restarting in 5s', { adapter: adapter.name, err });
                      setTimeout(startGateway, 5000);
                    }
                  });
              }
            });
        };
        startGateway();
        log.info('Gateway listener started', { adapter: adapter.name });
      }

      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    async deliver(platformId: string, threadId: string | null, message) {
      const tid = threadId ?? adapter.encodeThreadId({ guildId: '', channelId: platformId } as never);
      const content = message.content as Record<string, unknown>;

      if (content.operation === 'edit' && content.messageId) {
        await adapter.editMessage(tid, content.messageId as string, {
          markdown: (content.text as string) || (content.markdown as string) || '',
        });
        return;
      }

      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        await adapter.addReaction(tid, content.messageId as string, content.emoji as string);
        return;
      }

      // Normal message
      const text = (content.markdown as string) || (content.text as string);
      if (text) {
        await adapter.postMessage(tid, { markdown: text });
      }
    },

    async setTyping(platformId: string, threadId: string | null) {
      const tid = threadId ?? adapter.encodeThreadId({ guildId: '', channelId: platformId } as never);
      await adapter.startTyping(tid);
    },

    async teardown() {
      gatewayAbort?.abort();
      await chat.shutdown();
      log.info('Chat SDK bridge shut down', { adapter: adapter.name });
    },

    isConnected() {
      return true;
    },

    updateConversations(configs: ConversationConfig[]) {
      conversations = buildConversationMap(configs);
      // Subscribe new conversations
      for (const conv of configs) {
        if (conv.agentGroupId) {
          const threadId = adapter.encodeThreadId({ guildId: '', channelId: conv.platformId } as never);
          state.subscribe(threadId).catch(() => {});
        }
      }
    },
  };
}
