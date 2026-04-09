import type { Migration } from './index.js';

export const migration003: Migration = {
  version: 3,
  name: 'pending-approvals',
  up(db) {
    db.exec(`
      CREATE TABLE pending_approvals (
        approval_id  TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(id),
        request_id   TEXT NOT NULL,
        action       TEXT NOT NULL,
        payload      TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
    `);
  },
};
