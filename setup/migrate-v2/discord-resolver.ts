/**
 * Discord channel → guild resolver for the v1 → v2 migration.
 *
 * v1 stored Discord groups as `dc:<channelId>` — only the channel id, not
 * the guild id. v2's `@chat-adapter/discord` encodes `platform_id` as
 * `discord:<guildId>:<channelId>`, so we can't reconstruct it from v1 data
 * alone. Instead, we use the v1 bot token (carried forward by 1a-env) to
 * query the Discord API and build a channelId → guildId map.
 *
 * Network calls are best-effort: on auth failure or network error, the
 * resolver returns null for every channel and the caller falls back to
 * skipping with a clear warning.
 */

const DISCORD_API = 'https://discord.com/api/v10';

interface Guild {
  id: string;
  name: string;
}

interface Channel {
  id: string;
  name?: string;
}

export interface DiscordResolver {
  /** Returns `discord:<guildId>:<channelId>` or null if the channel isn't visible to the bot. */
  resolve(channelId: string): string | null;
  /** Diagnostic info — guild count and total channel count discovered. */
  stats(): { guilds: number; channels: number; reason?: string };
}

/** A no-op resolver that returns null for every lookup with a stored reason. */
function emptyResolver(reason: string): DiscordResolver {
  return {
    resolve: () => null,
    stats: () => ({ guilds: 0, channels: 0, reason }),
  };
}

type FetchFn = typeof fetch;

async function getJson<T>(url: string, token: string, fetchImpl: FetchFn): Promise<T> {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': 'NanoClaw-Migration (https://github.com/qwibitai/nanoclaw, 2.x)',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Build a Discord resolver by enumerating every guild the bot is in and
 * every channel in those guilds. Returns an empty resolver on any error.
 *
 * Costs: 1 + N HTTP calls (N = guild count). Discord's global rate limit
 * is 50 req/s; even installs with hundreds of guilds finish in under a
 * second of network time.
 */
export async function buildDiscordResolver(
  token: string,
  fetchImpl: FetchFn = fetch,
): Promise<DiscordResolver> {
  if (!token) return emptyResolver('no DISCORD_BOT_TOKEN in .env');

  // Page through guilds. Default page size is 200; loop until short page.
  const guilds: Guild[] = [];
  let after: string | null = null;
  try {
    while (true) {
      const url = new URL(`${DISCORD_API}/users/@me/guilds`);
      url.searchParams.set('limit', '200');
      if (after) url.searchParams.set('after', after);
      const page = await getJson<Guild[]>(url.toString(), token, fetchImpl);
      guilds.push(...page);
      if (page.length < 200) break;
      after = page[page.length - 1].id;
    }
  } catch (err) {
    return emptyResolver(`failed to list guilds: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Per-guild channel enumeration.
  const channelToGuild = new Map<string, string>();
  for (const guild of guilds) {
    try {
      const channels = await getJson<Channel[]>(
        `${DISCORD_API}/guilds/${guild.id}/channels`,
        token,
        fetchImpl,
      );
      for (const ch of channels) {
        channelToGuild.set(ch.id, guild.id);
      }
    } catch (err) {
      // Skip this guild but keep going — partial results are still useful.
      // The caller logs which channels couldn't be resolved.
      console.error(
        `WARN:discord-resolver: failed to enumerate guild ${guild.id} (${guild.name}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    resolve(channelId: string): string | null {
      const guildId = channelToGuild.get(channelId);
      if (!guildId) return null;
      return `discord:${guildId}:${channelId}`;
    },
    stats: () => ({ guilds: guilds.length, channels: channelToGuild.size }),
  };
}
