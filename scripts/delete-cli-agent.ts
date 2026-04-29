/**
 * Delete the scratch CLI agent created during setup's ping-pong test.
 *
 * Removes the agent group, its messaging_group_agents wiring, any
 * agent_destinations rows, and the groups/<folder>/ directory. Leaves the
 * CLI messaging group intact so it can be reused for a new agent.
 *
 * Usage:
 *   pnpm exec tsx scripts/delete-cli-agent.ts --folder <folder-name>
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroupByFolder, deleteAgentGroup } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

interface Args {
  folder: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let folder = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folder' && argv[i + 1]) folder = argv[++i];
  }
  if (!folder) {
    console.error('usage: pnpm exec tsx scripts/delete-cli-agent.ts --folder <folder-name>');
    process.exit(1);
  }
  return { folder };
}

const args = parseArgs();

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const ag = getAgentGroupByFolder(args.folder);
if (!ag) {
  console.log(`No agent group with folder "${args.folder}" — nothing to delete.`);
  process.exit(0);
}

// Delete all rows referencing this agent group, in dependency order.
const fkTables = [
  'messaging_group_agents',
  'agent_destinations',
  'agent_group_members',
  'pending_sender_approvals',
  'channel_registrations',
  'user_roles',
  'sessions',
];
for (const table of fkTables) {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  if (exists) {
    db.prepare(`DELETE FROM ${table} WHERE agent_group_id = ?`).run(ag.id);
  }
}

deleteAgentGroup(ag.id);

// Remove the groups/<folder>/ directory.
const groupDir = path.join(process.cwd(), 'groups', args.folder);
if (fs.existsSync(groupDir)) {
  fs.rmSync(groupDir, { recursive: true });
}

console.log(`Deleted agent group ${ag.id} (${args.folder}).`);
