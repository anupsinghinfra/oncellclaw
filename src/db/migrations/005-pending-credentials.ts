import type { Migration } from './index.js';

/**
 * `pending_credentials` — backs the trigger_credential_collection flow.
 * One row per in-flight credential request; status transitions
 * pending → submitted → saved | rejected | failed.
 */
export const migration005: Migration = {
  version: 5,
  name: 'pending-credentials',
  up(db) {
    db.exec(`
      CREATE TABLE pending_credentials (
        id                   TEXT PRIMARY KEY,
        agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
        session_id           TEXT REFERENCES sessions(id),
        name                 TEXT NOT NULL,
        type                 TEXT NOT NULL,
        host_pattern         TEXT NOT NULL,
        path_pattern         TEXT,
        header_name          TEXT,
        value_format         TEXT,
        description          TEXT,
        channel_type         TEXT NOT NULL,
        platform_id          TEXT NOT NULL,
        platform_message_id  TEXT,
        status               TEXT NOT NULL DEFAULT 'pending',
        created_at           TEXT NOT NULL
      );

      CREATE INDEX idx_pending_credentials_status ON pending_credentials(status);
    `);
  },
};
