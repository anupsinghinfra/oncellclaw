/**
 * Non-interactive provisioning of one web-channel agent group.
 *
 * This is the `setup/` wizard's effect without the wizard: everything a
 * cold install needs to answer an HTTP message, and nothing else. It is the
 * step `scripts/cloud-start.sh` runs on first boot, and it is equally usable
 * by a self-hoster who wants a scripted install.
 *
 * It composes the existing creation paths rather than reimplementing them —
 * `createAgentGroup` + `initGroupFilesystem` (persona, container config),
 * `createMessagingGroup` + `createMessagingGroupAgent` (wiring and its
 * companion destination row), and the permissions module's user/role/member
 * helpers. Engage and policy defaults come from the `web` channel's own
 * declaration via `resolveWiringDefaults` / `resolveUnknownSenderPolicy`,
 * so this script never hardcodes what the channel already declares.
 *
 * Idempotent in every step: each object is looked up before it is created,
 * so re-running (a cell restart, a re-deploy, a retried bootstrap) converges
 * instead of duplicating. The returned `created` flags say what actually
 * changed.
 *
 * Requires the central DB to be open (initDb + runMigrations) — callers own
 * that, because the host process and the CLI script open it differently.
 */
import path from 'path';

import { resolveUnknownSenderPolicy, resolveWiringDefaults } from './channels/channel-defaults.js';
import { WEB_CHANNEL_TYPE, WEB_DEFAULT_USER } from './channels/web.js';
import { GROUPS_DIR } from './config.js';
import { createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from './db/messaging-groups.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import { normalizeName } from './modules/agent-to-agent/db/agent-destinations.js';
import { addMember } from './modules/permissions/db/agent-group-members.js';
import { getUserRoles, grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';
import type { AgentGroup, MessagingGroup } from './types.js';

export interface ProvisionWebGroupOptions {
  /** Group slug: the agent group's folder AND the web platform id (URL segment). */
  group: string;
  /** Agent display name. Defaults to the slug. */
  displayName?: string;
  /** Standing instructions staged as the group's persona. Written once, never overwritten. */
  persona?: string;
  /** Agent provider for a newly created group. Omitted = instance default. */
  provider?: string;
  /** Handle of the human who owns this instance; namespaced `web:<handle>`. */
  ownerHandle?: string;
}

export interface ProvisionWebGroupResult {
  slug: string;
  agentGroupId: string;
  messagingGroupId: string;
  ownerUserId: string;
  created: {
    agentGroup: boolean;
    messagingGroup: boolean;
    wiring: boolean;
    ownerGrant: boolean;
  };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_PERSONA = (name: string): string =>
  `# ${name}\n\n` +
  `You are ${name}, a personal assistant reachable over the web. ` +
  'When someone first reaches out, introduce yourself briefly and invite them to chat. Keep replies concise.';

/**
 * Create (or converge on) one agent group paired to the `web` channel.
 *
 * @throws when `group` normalizes to an empty slug.
 */
export function provisionWebGroup(opts: ProvisionWebGroupOptions): ProvisionWebGroupResult {
  const slug = normalizeName(opts.group);
  if (!slug || slug === 'unnamed') {
    throw new Error(`Invalid group name: ${JSON.stringify(opts.group)} — must contain letters or digits`);
  }
  const displayName = opts.displayName?.trim() || opts.group.trim() || slug;
  const ownerHandle = opts.ownerHandle?.trim() || WEB_DEFAULT_USER;
  const ownerUserId = `${WEB_CHANNEL_TYPE}:${ownerHandle}`;
  const now = new Date().toISOString();

  // 1. Agent group + workspace. The folder is the identity we converge on —
  //    a second run finds it and creates nothing.
  let agentGroup: AgentGroup | undefined = getAgentGroupByFolder(slug);
  const createdAgentGroup = agentGroup === undefined;
  if (!agentGroup) {
    createAgentGroup({
      id: generateId('ag'),
      name: displayName,
      folder: slug,
      agent_provider: null,
      created_at: now,
    });
    agentGroup = getAgentGroupByFolder(slug)!;
  }

  // initGroupFilesystem is itself idempotent (every step gated on absence),
  // and stageGroupPersona uses an exclusive create — a persona edited inside
  // the running instance is never clobbered by a restart.
  initGroupFilesystem(agentGroup, {
    instructions: opts.persona?.trim() || DEFAULT_PERSONA(displayName),
    provider: opts.provider,
  });

  // 2. Owner identity. The web channel declares 'public' (the bearer token
  //    is the trust boundary), so this is not what admits messages — it is
  //    what makes admin-scoped slash commands work for the instance's human.
  upsertUser({ id: ownerUserId, kind: WEB_CHANNEL_TYPE, display_name: displayName, created_at: now });
  const alreadyOwner = getUserRoles(ownerUserId).some((r) => r.role === 'owner' && r.agent_group_id === null);
  if (!alreadyOwner) {
    grantRole({ user_id: ownerUserId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
    updateContainerConfigScalars(agentGroup.id, { cli_scope: 'global' });
  }
  addMember({ user_id: ownerUserId, agent_group_id: agentGroup.id, added_by: null, added_at: now });

  // 3. Messaging group — platform id IS the URL slug.
  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, slug);
  const createdMessagingGroup = mg === undefined;
  if (!mg) {
    createMessagingGroup({
      id: generateId('mg'),
      channel_type: WEB_CHANNEL_TYPE,
      platform_id: slug,
      instance: WEB_CHANNEL_TYPE,
      name: displayName,
      is_group: 0,
      unknown_sender_policy: resolveUnknownSenderPolicy(WEB_CHANNEL_TYPE, false),
      denied_at: null,
      created_at: now,
    });
    mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, slug)!;
  }

  // 4. Wiring, from the channel's declared DM defaults.
  const existingWiring = getMessagingGroupAgentByPair(mg.id, agentGroup.id);
  const createdWiring = existingWiring === undefined;
  if (!existingWiring) {
    const engage = resolveWiringDefaults(WEB_CHANNEL_TYPE, false, agentGroup.name);
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: agentGroup.id,
      engage_mode: engage.engage_mode,
      engage_pattern: engage.engage_pattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  }

  const result: ProvisionWebGroupResult = {
    slug,
    agentGroupId: agentGroup.id,
    messagingGroupId: mg.id,
    ownerUserId,
    created: {
      agentGroup: createdAgentGroup,
      messagingGroup: createdMessagingGroup,
      wiring: createdWiring,
      ownerGrant: !alreadyOwner,
    },
  };

  log.info('Web group provisioned', {
    ...result,
    workspace: path.resolve(GROUPS_DIR, slug),
  });
  return result;
}
