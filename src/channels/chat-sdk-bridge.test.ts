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

describe('shouldEngage', () => {
  describe('unknown conversation', () => {
    const empty = new Map<string, ConversationConfig[]>();
    const sources: EngageSource[] = ['subscribed', 'mention', 'dm'];
    for (const source of sources) {
      it(`forwards for source='${source}' (may be a not-yet-wired group)`, () => {
        expect(shouldEngage(empty, 'C1', source, '')).toEqual({ forward: true, stickySubscribe: false });
      });
    }
    it("DROPS for source='new-message' (would flood from unwired channels)", () => {
      expect(shouldEngage(empty, 'C1', 'new-message', 'hello')).toEqual({
        forward: false,
        stickySubscribe: false,
      });
    });
  });

  describe("engageMode='mention' + ignoredMessagePolicy='drop' (default)", () => {
    const conv = mapFor(cfg({ engageMode: 'mention' }));
    it('forwards on mention + dm', () => {
      expect(shouldEngage(conv, 'C1', 'mention', '').forward).toBe(true);
      expect(shouldEngage(conv, 'C1', 'dm', '').forward).toBe(true);
    });
    it('does NOT forward on subscribed or new-message (prevents keep-firing + flooding)', () => {
      expect(shouldEngage(conv, 'C1', 'subscribed', '').forward).toBe(false);
      expect(shouldEngage(conv, 'C1', 'new-message', '').forward).toBe(false);
    });
    it('never asks to subscribe', () => {
      for (const s of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
        expect(shouldEngage(conv, 'C1', s, '').stickySubscribe).toBe(false);
      }
    });
  });

  describe("engageMode='mention-sticky'", () => {
    const conv = mapFor(cfg({ engageMode: 'mention-sticky' }));
    it('forwards on mention + dm with stickySubscribe=true', () => {
      expect(shouldEngage(conv, 'C1', 'mention', '')).toEqual({ forward: true, stickySubscribe: true });
      expect(shouldEngage(conv, 'C1', 'dm', '')).toEqual({ forward: true, stickySubscribe: true });
    });
    it('forwards subscribed follow-ups without re-subscribing', () => {
      expect(shouldEngage(conv, 'C1', 'subscribed', '')).toEqual({ forward: true, stickySubscribe: false });
    });
    it('does NOT forward on new-message (explicit mention required to start)', () => {
      expect(shouldEngage(conv, 'C1', 'new-message', '').forward).toBe(false);
    });
  });

  describe("engageMode='pattern'", () => {
    it('pattern="." forwards on every source (when conversation is known)', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: '.' }));
      for (const s of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
        expect(shouldEngage(conv, 'C1', s, 'anything').forward).toBe(true);
      }
    });

    it('tests regex against text on new-message (the main bug fix)', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: '^!report' }));
      expect(shouldEngage(conv, 'C1', 'new-message', '!report now').forward).toBe(true);
      expect(shouldEngage(conv, 'C1', 'new-message', 'nothing to see').forward).toBe(false);
    });

    it('pattern regex applies on every source (symmetry)', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: 'deploy' }));
      for (const s of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
        expect(shouldEngage(conv, 'C1', s, 'time to deploy').forward).toBe(true);
        expect(shouldEngage(conv, 'C1', s, 'weather today').forward).toBe(false);
      }
    });

    it('pattern never triggers sticky-subscribe', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: '.' }));
      for (const s of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
        expect(shouldEngage(conv, 'C1', s, 'hi').stickySubscribe).toBe(false);
      }
    });

    it('invalid regex fails open (admin sees something rather than silent drop)', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: '[unclosed' }));
      expect(shouldEngage(conv, 'C1', 'new-message', 'x').forward).toBe(true);
    });
  });

  describe("ignoredMessagePolicy='accumulate'", () => {
    it('forwards non-engaging new-message so the router can store it as context (trigger=0)', () => {
      const conv = mapFor(cfg({ engageMode: 'mention', ignoredMessagePolicy: 'accumulate' }));
      // Plain message in unsubscribed group — mention rule says no engage,
      // but accumulate says forward anyway.
      expect(shouldEngage(conv, 'C1', 'new-message', 'chit chat')).toEqual({
        forward: true,
        stickySubscribe: false,
      });
    });

    it('forwards non-engaging subscribed messages for accumulation', () => {
      // mention wiring in a subscribed thread: the mention handler already
      // fired once, thread is now subscribed, follow-ups route here. The
      // base 'mention' rule wouldn't engage without an @-mention, but
      // accumulate says capture the context.
      const conv = mapFor(cfg({ engageMode: 'mention', ignoredMessagePolicy: 'accumulate' }));
      expect(shouldEngage(conv, 'C1', 'subscribed', 'follow up talk').forward).toBe(true);
    });

    it('does NOT set stickySubscribe purely from accumulate (avoid misleading bot presence)', () => {
      const conv = mapFor(cfg({ engageMode: 'mention-sticky', ignoredMessagePolicy: 'accumulate' }));
      expect(shouldEngage(conv, 'C1', 'new-message', 'plain').stickySubscribe).toBe(false);
    });

    it("accumulate doesn't override the 'unknown conversation → drop new-message' rule", () => {
      // Unknown conversation (not in map): accumulate can't be read because
      // there's no config to read from. We still drop.
      const empty = new Map<string, ConversationConfig[]>();
      expect(shouldEngage(empty, 'C-unknown', 'new-message', 'x').forward).toBe(false);
    });

    it("drop policy + non-engaging message → doesn't forward", () => {
      const conv = mapFor(cfg({ engageMode: 'mention', ignoredMessagePolicy: 'drop' }));
      expect(shouldEngage(conv, 'C1', 'new-message', 'plain').forward).toBe(false);
    });

    it('engaging message with drop policy still forwards (engage wins regardless)', () => {
      const conv = mapFor(cfg({ engageMode: 'mention', ignoredMessagePolicy: 'drop' }));
      expect(shouldEngage(conv, 'C1', 'mention', '@bot hi').forward).toBe(true);
    });
  });

  describe('multiple wirings on one conversation', () => {
    it('takes the union across wirings (any-engage wins)', () => {
      // mention wiring + pattern wiring on the same channel. A plain message
      // should engage via the pattern wiring even though the mention wiring
      // alone would reject it.
      const conv = mapFor(
        cfg({ agentGroupId: 'ag-a', engageMode: 'mention' }),
        cfg({ agentGroupId: 'ag-b', engageMode: 'pattern', engagePattern: '^hi' }),
      );
      expect(shouldEngage(conv, 'C1', 'new-message', 'hi there').forward).toBe(true);
      expect(shouldEngage(conv, 'C1', 'new-message', 'something else').forward).toBe(false);
    });

    it('any accumulate wiring causes forward even if all others would drop', () => {
      const conv = mapFor(
        cfg({ agentGroupId: 'ag-a', engageMode: 'mention', ignoredMessagePolicy: 'drop' }),
        cfg({ agentGroupId: 'ag-b', engageMode: 'mention', ignoredMessagePolicy: 'accumulate' }),
      );
      // Plain message: ag-a would drop, ag-b would accumulate → forward.
      expect(shouldEngage(conv, 'C1', 'new-message', 'plain').forward).toBe(true);
    });

    it('stickySubscribe from any mention-sticky wiring wins', () => {
      const conv = mapFor(
        cfg({ agentGroupId: 'ag-a', engageMode: 'mention' }),
        cfg({ agentGroupId: 'ag-b', engageMode: 'mention-sticky' }),
      );
      expect(shouldEngage(conv, 'C1', 'mention', '')).toEqual({ forward: true, stickySubscribe: true });
    });
  });
});
