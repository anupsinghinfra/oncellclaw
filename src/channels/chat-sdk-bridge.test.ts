import { describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import type { ConversationConfig } from './adapter.js';
import { createChatSdkBridge, shouldEngage, type EngageSource } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

function cfg(
  partial: Partial<ConversationConfig> & { engageMode: ConversationConfig['engageMode'] },
): ConversationConfig {
  return {
    platformId: partial.platformId ?? 'C1',
    agentGroupId: partial.agentGroupId ?? 'ag-1',
    engageMode: partial.engageMode,
    engagePattern: partial.engagePattern ?? null,
    ignoredMessagePolicy: partial.ignoredMessagePolicy ?? 'drop',
    sessionMode: partial.sessionMode ?? 'shared',
  };
}

function mapFor(...configs: ConversationConfig[]): Map<string, ConversationConfig[]> {
  const map = new Map<string, ConversationConfig[]>();
  for (const c of configs) {
    const existing = map.get(c.platformId);
    if (existing) existing.push(c);
    else map.set(c.platformId, [c]);
  }
  return map;
}

describe('createChatSdkBridge', () => {
  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });
});

describe('shouldEngage (bridge-level flood gate + subscribe signal)', () => {
  // Per-wiring engage_mode / engage_pattern / ignored_message_policy
  // semantics live in the router (evaluateEngage / routeInbound fan-out).
  // These tests only cover the bridge's two responsibilities: should we
  // forward at all, and should we call thread.subscribe().

  describe('flood gate — unknown conversation', () => {
    const empty = new Map<string, ConversationConfig[]>();
    const carriedSources: EngageSource[] = ['subscribed', 'mention', 'dm'];
    for (const source of carriedSources) {
      it(`forwards for source='${source}' (may be a newly-auto-created channel or a channel-registration trigger)`, () => {
        expect(shouldEngage(empty, 'C-new', source)).toEqual({ forward: true, stickySubscribe: false });
      });
    }
    it("DROPS for source='new-message' (onNewMessage(/./) fires for every unsubscribed thread the bot can see — would flood)", () => {
      expect(shouldEngage(empty, 'C-unwired', 'new-message')).toEqual({
        forward: false,
        stickySubscribe: false,
      });
    });
  });

  describe('known conversation — bridge forwards regardless of engage mode', () => {
    // Policy lives in the router now. The bridge only knows "has any wiring".
    const conv = mapFor(cfg({ engageMode: 'mention' }));
    for (const source of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
      it(`forwards for source='${source}' — router will decide engage / accumulate / drop per wiring`, () => {
        expect(shouldEngage(conv, 'C1', source).forward).toBe(true);
      });
    }
  });

  describe('stickySubscribe signal', () => {
    it('true when any mention-sticky wiring exists AND source is mention', () => {
      const conv = mapFor(cfg({ engageMode: 'mention-sticky' }));
      expect(shouldEngage(conv, 'C1', 'mention').stickySubscribe).toBe(true);
    });

    it('true when any mention-sticky wiring exists AND source is dm', () => {
      const conv = mapFor(cfg({ engageMode: 'mention-sticky' }));
      expect(shouldEngage(conv, 'C1', 'dm').stickySubscribe).toBe(true);
    });

    it('false on subscribed — thread is already subscribed, no need to re-subscribe', () => {
      const conv = mapFor(cfg({ engageMode: 'mention-sticky' }));
      expect(shouldEngage(conv, 'C1', 'subscribed').stickySubscribe).toBe(false);
    });

    it('false on new-message — mention-sticky requires an explicit mention to start', () => {
      const conv = mapFor(cfg({ engageMode: 'mention-sticky' }));
      expect(shouldEngage(conv, 'C1', 'new-message').stickySubscribe).toBe(false);
    });

    it('false for plain mention / pattern wirings (not sticky)', () => {
      const mentionConv = mapFor(cfg({ engageMode: 'mention' }));
      const patternConv = mapFor(cfg({ engageMode: 'pattern', engagePattern: '.' }));
      for (const s of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
        expect(shouldEngage(mentionConv, 'C1', s).stickySubscribe).toBe(false);
        expect(shouldEngage(patternConv, 'C1', s).stickySubscribe).toBe(false);
      }
    });

    it('fires on coarse union — mixed wirings where any one is mention-sticky', () => {
      const conv = mapFor(
        cfg({ agentGroupId: 'ag-a', engageMode: 'mention' }),
        cfg({ agentGroupId: 'ag-b', engageMode: 'mention-sticky' }),
      );
      expect(shouldEngage(conv, 'C1', 'mention').stickySubscribe).toBe(true);
    });
  });
});
