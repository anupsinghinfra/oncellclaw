/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { log } from '../log.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Two gateway instances of one platform (e.g. two Discord bots) identifying
 * simultaneously from one IP trip platform rate limits at boot. Stagger the
 * second (and later) same-platform adapter's setup. Inert for installs with
 * one adapter per platform — no two registrations share a channelType.
 */
const SAME_CHANNEL_SETUP_STAGGER_MS = 10_000;

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by instance name, falling back to any adapter of the
 *  given channel type. channelType-only callers (user-id prefix resolution
 *  and cold DMs in user-dm.ts, approval delivery in channel-approval.ts)
 *  must still resolve when every instance of a platform is named — first
 *  registered wins (Map insertion order, deterministic). Default instances
 *  are keyed by channelType itself, so single-instance installs always hit
 *  the exact-key path. */
export function getChannelAdapter(key: string): ChannelAdapter | undefined {
  const exact = activeAdapters.get(key);
  if (exact) return exact;
  for (const adapter of activeAdapters.values()) {
    if (adapter.channelType === key) return adapter;
  }
  return undefined;
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  const activeChannelTypes = new Set<string>();
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      // Same-platform stagger: a second instance of an already-active
      // platform waits before identifying (gateway logins from one IP).
      if (activeChannelTypes.has(adapter.channelType)) {
        log.info('Staggering same-platform adapter setup', {
          channel: name,
          type: adapter.channelType,
          delayMs: SAME_CHANNEL_SETUP_STAGGER_MS,
        });
        await sleep(SAME_CHANNEL_SETUP_STAGGER_MS);
      }

      const setup = setupFn(adapter);
      // Transient network failures during adapter init (e.g. Telegram deleteWebhook
      // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
      // dead until manual restart. Retry only on NetworkError so misconfigs (bad
      // tokens, etc.) still fail fast.
      let attempt = 0;
      while (true) {
        try {
          await adapter.setup(setup);
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with network error, retrying', {
              channel: name,
              attempt: attempt + 1,
              delayMs: delay,
              err: err.message,
            });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      // Adapters key by instance (default instance = channelType), so N
      // instances of one platform coexist. Duplicate keys warn instead of
      // throwing — boot stays resilient, matching the historical silent
      // last-write-wins, but now visibly.
      const key = adapter.instance ?? adapter.channelType;
      if (activeAdapters.has(key)) {
        log.warn('Duplicate adapter instance key — overwriting previous adapter', { key, channel: name });
      }
      activeAdapters.set(key, adapter);
      activeChannelTypes.add(adapter.channelType);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType, instance: key });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}
