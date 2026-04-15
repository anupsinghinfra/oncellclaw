import type { Migration } from './index.js';

/**
 * `pending_swaps` — backs the builder-agent self-modification flow. One row
 * per in-flight swap request from a dev agent. Everything swap-lifecycle fits
 * on one row: approval state, classification, pre-swap git SHA for rollback,
 * DB snapshot path, deadman timer, handshake state.
 *
 * Status transitions: pending_approval → awaiting_confirmation →
 *   (finalized | rolled_back | rejected).
 *
 * Handshake state (only meaningful while status = awaiting_confirmation):
 *   pending_restart → message1_sent → confirmed | rolled_back.
 */
export const migration006: Migration = {
  version: 6,
  name: 'pending-swaps',
  up(db) {
    db.exec(`
      CREATE TABLE pending_swaps (
        request_id            TEXT PRIMARY KEY,
        dev_agent_id          TEXT NOT NULL REFERENCES agent_groups(id),
        originating_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
        dev_branch            TEXT NOT NULL,
        commit_sha            TEXT NOT NULL,
        classification        TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'pending_approval',
        summary_json          TEXT NOT NULL,
        pre_swap_sha          TEXT,
        db_snapshot_path      TEXT,
        deadman_started_at    TEXT,
        deadman_expires_at    TEXT,
        handshake_state       TEXT,
        created_at            TEXT NOT NULL
      );

      CREATE INDEX idx_pending_swaps_originating_status
        ON pending_swaps(originating_group_id, status);

      CREATE INDEX idx_pending_swaps_status
        ON pending_swaps(status);
    `);
  },
};
