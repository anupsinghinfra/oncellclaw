import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { migration001 } from './001-initial.js';
import { migration002 } from './002-chat-sdk-state.js';
import { migration003 } from './003-pending-approvals.js';
import { migration004 } from './004-agent-destinations.js';
import { migration007 } from './007-pending-approvals-title-options.js';
import { migration008 } from './008-dropped-messages.js';
import { migration009 } from './009-drop-pending-credentials.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration007,
  migration008,
  migration009,
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  // Uniqueness is keyed on `name`, not `version`. This lets module
  // migrations (added later by install skills) pick arbitrary version
  // numbers without coordinating across modules. `version` stays on
  // the Migration object as an ordering hint within the barrel array;
  // the stored `version` column is auto-assigned at insert time as an
  // applied-order number.
  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;

  log.info('Running migrations', { count: pending.length });

  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      const next =
        (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number }).v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        next,
        m.name,
        new Date().toISOString(),
      );
    })();
    log.info('Migration applied', { name: m.name });
  }
}
