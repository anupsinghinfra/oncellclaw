/**
 * Shared helpers for the v1 → v2 migration steps.
 */

// ── JID parsing ─────────────────────────────────────────────────────────

/** v1 JID prefix → v2 channel_type. Unknown prefixes pass through as-is. */
export const JID_PREFIX_TO_CHANNEL: Record<string, string> = {
  dc: 'discord',
  discord: 'discord',
  tg: 'telegram',
  telegram: 'telegram',
  wa: 'whatsapp',
  whatsapp: 'whatsapp',
  slack: 'slack',
  matrix: 'matrix',
  mx: 'matrix',
  teams: 'teams',
  imessage: 'imessage',
  im: 'imessage',
  email: 'email',
  webex: 'webex',
  gchat: 'gchat',
  linear: 'linear',
  github: 'github',
};

export interface ParsedJid {
  raw: string;
  prefix: string;
  id: string;
  channel_type: string;
}

export function parseJid(raw: string): ParsedJid | null {
  const colon = raw.indexOf(':');
  if (colon === -1) return null;
  const prefix = raw.slice(0, colon).toLowerCase();
  const id = raw.slice(colon + 1);
  if (!prefix || !id) return null;
  return {
    raw,
    prefix,
    id,
    channel_type: JID_PREFIX_TO_CHANNEL[prefix] ?? prefix,
  };
}

/**
 * Build a v2 platform_id from a v1 JID. v2's messaging_groups.platform_id
 * is always `<channel_type>:<id>`.
 */
export function v2PlatformId(channelType: string, jid: string): string {
  const parsed = parseJid(jid);
  const id = parsed?.id ?? jid;
  return id.startsWith(`${channelType}:`) ? id : `${channelType}:${id}`;
}

// ── Trigger mapping ─────────────────────────────────────────────────────

/**
 * Map v1's trigger_pattern + requires_trigger to v2's engage_mode + engage_pattern.
 *
 * Key rule: requires_trigger=0 means "respond to everything" regardless
 * of the pattern value. The pattern was for mention highlighting, not gating.
 */
export function triggerToEngage(input: {
  trigger_pattern: string | null;
  requires_trigger: number | null;
}): {
  engage_mode: 'pattern' | 'mention' | 'mention-sticky';
  engage_pattern: string | null;
} {
  const pattern = input.trigger_pattern && input.trigger_pattern.trim().length > 0 ? input.trigger_pattern : null;
  const requiresTrigger = input.requires_trigger !== 0;

  if (pattern === '.' || pattern === '.*') {
    return { engage_mode: 'pattern', engage_pattern: '.' };
  }
  if (!requiresTrigger) {
    return { engage_mode: 'pattern', engage_pattern: '.' };
  }
  if (pattern) {
    return { engage_mode: 'pattern', engage_pattern: pattern };
  }
  return { engage_mode: 'mention', engage_pattern: null };
}

// ── ID generation ───────────────────────────────────────────────────────

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Channel auth registry ───────────────────────────────────────────────

export interface ChannelAuthSpec {
  v1EnvKeys: string[];
  requiredV2Keys: { key: string; where: string }[];
  candidatePaths: string[];
  note?: string;
}

export const CHANNEL_AUTH_REGISTRY: Record<string, ChannelAuthSpec> = {
  discord: {
    v1EnvKeys: ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'],
    requiredV2Keys: [
      { key: 'DISCORD_BOT_TOKEN', where: 'Discord Developer Portal → Application → Bot → Token' },
      { key: 'DISCORD_APPLICATION_ID', where: 'Discord Developer Portal → Application → General → Application ID' },
      { key: 'DISCORD_PUBLIC_KEY', where: 'Discord Developer Portal → Application → General → Public Key' },
    ],
    candidatePaths: [],
    note: 'v1 used raw discord.js (bot token only). v2 uses Chat SDK and needs APPLICATION_ID + PUBLIC_KEY too.',
  },
  telegram: {
    v1EnvKeys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'],
    requiredV2Keys: [
      { key: 'TELEGRAM_BOT_TOKEN', where: 'BotFather on Telegram → /mybots → Bot → API Token' },
    ],
    candidatePaths: ['data/sessions/telegram', 'store/telegram-session'],
  },
  whatsapp: {
    v1EnvKeys: ['WHATSAPP_PHONE', 'WHATSAPP_OWNER'],
    requiredV2Keys: [],
    candidatePaths: [
      'data/sessions/baileys',
      'data/baileys_auth',
      'store/auth_info_baileys',
      'store/baileys',
      'auth_info_baileys',
    ],
    note: 'Baileys keystore — copying is best-effort. Encryption sessions may still need a fresh pair via /add-whatsapp.',
  },
  matrix: {
    v1EnvKeys: ['MATRIX_HOMESERVER', 'MATRIX_USER_ID', 'MATRIX_ACCESS_TOKEN'],
    requiredV2Keys: [
      { key: 'MATRIX_HOMESERVER', where: 'your Matrix homeserver URL (e.g. https://matrix.org)' },
      { key: 'MATRIX_ACCESS_TOKEN', where: 'Element → Settings → Help & About → Access Token (keep secret)' },
    ],
    candidatePaths: ['data/matrix-store', 'store/matrix', 'data/sessions/matrix'],
  },
  slack: {
    v1EnvKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'],
    requiredV2Keys: [
      { key: 'SLACK_BOT_TOKEN', where: 'Slack app → OAuth & Permissions → Bot User OAuth Token (xoxb-…)' },
      { key: 'SLACK_SIGNING_SECRET', where: 'Slack app → Basic Information → Signing Secret' },
    ],
    candidatePaths: [],
  },
  teams: {
    v1EnvKeys: ['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID'],
    requiredV2Keys: [
      { key: 'TEAMS_APP_ID', where: 'Azure portal → App registration → Application (client) ID' },
      { key: 'TEAMS_APP_PASSWORD', where: 'Azure portal → App registration → Certificates & secrets' },
    ],
    candidatePaths: [],
  },
  imessage: {
    v1EnvKeys: ['IMESSAGE_PHOTON_URL', 'IMESSAGE_PHOTON_TOKEN'],
    requiredV2Keys: [],
    candidatePaths: ['data/imessage', 'store/imessage'],
  },
  webex: {
    v1EnvKeys: ['WEBEX_BOT_TOKEN'],
    requiredV2Keys: [{ key: 'WEBEX_BOT_TOKEN', where: 'Webex developer portal → Bot → Bot Access Token' }],
    candidatePaths: [],
  },
  gchat: {
    v1EnvKeys: ['GCHAT_SERVICE_ACCOUNT', 'GCHAT_WEBHOOK_URL'],
    requiredV2Keys: [],
    candidatePaths: ['data/gchat-credentials.json', 'store/gchat-sa.json'],
  },
  resend: {
    v1EnvKeys: ['RESEND_API_KEY', 'RESEND_FROM'],
    requiredV2Keys: [{ key: 'RESEND_API_KEY', where: 'resend.com → API Keys' }],
    candidatePaths: [],
  },
  github: {
    v1EnvKeys: ['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY_PATH'],
    requiredV2Keys: [],
    candidatePaths: [],
    note: 'Webhook channel — secrets carry over, but GitHub webhook URLs are new per v2 install.',
  },
  linear: {
    v1EnvKeys: ['LINEAR_API_KEY', 'LINEAR_WEBHOOK_SECRET'],
    requiredV2Keys: [{ key: 'LINEAR_API_KEY', where: 'Linear → Settings → API → Personal API keys' }],
    candidatePaths: [],
  },
};
