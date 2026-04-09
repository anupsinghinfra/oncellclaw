/**
 * Outbound message operations (container side).
 *
 * Writes to outbound.db (container-owned).
 * The host polls this DB (read-only) for undelivered messages.
 */
import { getInboundDb, getOutboundDb } from './connection.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/**
 * Write a new outbound message, auto-assigning an odd seq number.
 * Container uses odd seq (1, 3, 5...), host uses even (2, 4, 6...) —
 * this prevents seq collisions without cross-DB coordination.
 */
export function writeMessageOut(msg: WriteMessageOut): number {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();

  // Read max seq from both DBs to maintain global ordering.
  // Safe: each side only reads the other DB, never writes to it.
  const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  const max = Math.max(maxOut, maxIn);
  const nextSeq = max % 2 === 0 ? max + 1 : max + 2; // next odd

  outbound
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES (@id, @seq, @in_reply_to, datetime('now'), @deliver_after, @recurrence, @kind, @platform_id, @channel_type, @thread_id, @content)`,
    )
    .run({
      in_reply_to: null,
      deliver_after: null,
      recurrence: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      ...msg,
      seq: nextSeq,
    });

  return nextSeq;
}

/**
 * Look up a message's platform ID by seq number.
 * Searches both inbound and outbound DBs since seq spans both.
 */
export function getMessageIdBySeq(seq: number): string | null {
  const inRow = getInboundDb().prepare('SELECT id FROM messages_in WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (inRow) return inRow.id;
  const outRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  return outRow?.id ?? null;
}

/** Get undelivered messages (for host polling — reads from outbound.db). */
export function getUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}
