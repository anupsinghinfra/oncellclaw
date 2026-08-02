import type { Migration } from './index.js';

/**
 * Per-group web archive epoch on `messaging_groups`.
 *
 * NULL = never archived, matching pre-migration behavior for every existing
 * row — deliberately no backfill. A non-NULL value is a web transcript
 * cursor (`<ts>|<zero-padded index>`, see src/channels/web.ts); the web
 * channel's /transcript and /stream endpoints render only rows AFTER it.
 * Nothing is ever deleted — durable memory is the product; the epoch only
 * moves the rendered view's start.
 */
export const migration021: Migration = {
  version: 21,
  name: 'web-archive-epoch',
  up(db) {
    db.exec(`ALTER TABLE messaging_groups ADD COLUMN archive_epoch TEXT;`);
  },
};
