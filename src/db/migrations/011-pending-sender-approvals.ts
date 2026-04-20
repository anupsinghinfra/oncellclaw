/**
 * Unknown-sender approval flow. When `unknown_sender_policy = 'request_approval'`
 * a non-member message triggers a card to the most appropriate admin. An
 * in-flight entry in this table dedups concurrent attempts from the same
 * sender; the row is cleared on approve / deny.
 *
 * Also flips the `messaging_groups.unknown_sender_policy` default from 'strict'
 * to 'request_approval' so fresh wirings don't silently swallow messages from
 * users the admin hasn't added yet. Existing rows are left as-is (silent
 * upgrade would change established behavior without the admin asking for it).
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration011: Migration = {
  version: 11,
  name: 'pending-sender-approvals',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_sender_approvals (
        id                   TEXT PRIMARY KEY,
        messaging_group_id   TEXT NOT NULL REFERENCES messaging_groups(id),
        agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
        sender_identity      TEXT NOT NULL,      -- namespaced user id (channel_type:handle)
        sender_name          TEXT,
        original_message     TEXT NOT NULL,      -- JSON serialized InboundEvent
        approver_user_id     TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        UNIQUE(messaging_group_id, sender_identity)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_sender_approvals_mg
        ON pending_sender_approvals(messaging_group_id);
    `);

    // Default-flip: fresh messaging_groups default to request_approval instead
    // of silently dropping. SQLite doesn't support modifying column DEFAULTs
    // in place, so we rebuild the table via the classic rename-copy-drop
    // pattern. Existing rows keep their current unknown_sender_policy value.
    db.exec(`
      CREATE TABLE messaging_groups_new (
        id                    TEXT PRIMARY KEY,
        channel_type          TEXT NOT NULL,
        platform_id           TEXT NOT NULL,
        name                  TEXT,
        is_group              INTEGER DEFAULT 0,
        unknown_sender_policy TEXT NOT NULL DEFAULT 'request_approval',
        created_at            TEXT NOT NULL,
        UNIQUE(channel_type, platform_id)
      );
      INSERT INTO messaging_groups_new
        SELECT id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at
          FROM messaging_groups;
      DROP TABLE messaging_groups;
      ALTER TABLE messaging_groups_new RENAME TO messaging_groups;
    `);
  },
};
