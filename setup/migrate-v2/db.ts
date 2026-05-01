/**
 * migrate-v2 step: db
 *
 * Seed v2.db from v1's registered_groups table.
 * Creates agent_groups, messaging_groups, and messaging_group_agents.
 *
 * Does NOT seed users/user_roles — the /migrate-from-v1 skill handles that.
 *
 * Idempotent: re-running skips rows that already exist.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/db.ts <v1-path>
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { initDb } from '../../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import {
  generateId,
  parseJid,
  triggerToEngage,
  JID_PREFIX_TO_CHANNEL,
} from '../migrate-v1/shared.js';

interface V1Group {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string | null;
  requires_trigger: number | null;
  is_main: number | null;
}

function main(): void {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/db.ts <v1-path>');
    process.exit(1);
  }

  const v1DbPath = path.join(v1Path, 'store', 'messages.db');
  if (!fs.existsSync(v1DbPath)) {
    console.error(`v1 DB not found: ${v1DbPath}`);
    process.exit(1);
  }

  // Read v1 groups
  const v1Db = new Database(v1DbPath, { readonly: true, fileMustExist: true });

  // v1 schema varies — channel_name was a late addition. Query only the
  // columns we know exist in all v1 installs.
  const v1Groups = v1Db
    .prepare('SELECT jid, name, folder, trigger_pattern, requires_trigger, is_main FROM registered_groups')
    .all() as V1Group[];
  v1Db.close();

  if (v1Groups.length === 0) {
    console.log('SKIPPED:no registered groups in v1');
    process.exit(0);
  }

  // Init v2 DB
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const v2Db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(v2Db);

  let created = 0;
  let reused = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const g of v1Groups) {
    const parsed = parseJid(g.jid);
    if (!parsed) {
      skipped++;
      errors.push(`Could not parse JID: ${g.jid}`);
      continue;
    }

    const channelType = parsed.channel_type;
    const platformId = parsed.raw.startsWith(`${channelType}:`)
      ? parsed.raw
      : `${channelType}:${parsed.id}`;
    const createdAt = new Date().toISOString();

    try {
      // agent_group — one per folder
      let ag = getAgentGroupByFolder(g.folder);
      if (!ag) {
        createAgentGroup({
          id: generateId('ag'),
          name: g.name || g.folder,
          folder: g.folder,
          agent_provider: null,
          created_at: createdAt,
        });
        ag = getAgentGroupByFolder(g.folder)!;
      }

      // messaging_group — one per (channel_type, platform_id)
      let mg = getMessagingGroupByPlatform(channelType, platformId);
      if (!mg) {
        createMessagingGroup({
          id: generateId('mg'),
          channel_type: channelType,
          platform_id: platformId,
          name: g.name || null,
          is_group: 1,
          unknown_sender_policy: 'public',
          created_at: createdAt,
        });
        mg = getMessagingGroupByPlatform(channelType, platformId)!;
      }

      // messaging_group_agents — wire them
      const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
      if (!existing) {
        const engage = triggerToEngage({
          trigger_pattern: g.trigger_pattern,
          requires_trigger: g.requires_trigger,
        });
        createMessagingGroupAgent({
          id: generateId('mga'),
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: engage.engage_mode,
          engage_pattern: engage.engage_pattern,
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          session_mode: 'shared',
          priority: 0,
          created_at: createdAt,
        });
        created++;
      } else {
        reused++;
      }
    } catch (err) {
      skipped++;
      errors.push(`${g.folder}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  v2Db.close();

  console.log(`OK:groups=${v1Groups.length},created=${created},reused=${reused},skipped=${skipped}`);
  if (errors.length > 0) {
    for (const e of errors) console.log(`ERROR:${e}`);
  }
}

main();
