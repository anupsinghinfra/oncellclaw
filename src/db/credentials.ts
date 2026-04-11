import type { PendingCredential, PendingCredentialStatus } from '../types.js';
import { getDb } from './connection.js';

export function createPendingCredential(c: PendingCredential): void {
  getDb()
    .prepare(
      `INSERT INTO pending_credentials
         (id, agent_group_id, session_id, name, type, host_pattern, path_pattern,
          header_name, value_format, description, channel_type, platform_id,
          platform_message_id, status, created_at)
       VALUES
         (@id, @agent_group_id, @session_id, @name, @type, @host_pattern, @path_pattern,
          @header_name, @value_format, @description, @channel_type, @platform_id,
          @platform_message_id, @status, @created_at)`,
    )
    .run(c);
}

export function getPendingCredential(id: string): PendingCredential | undefined {
  return getDb().prepare('SELECT * FROM pending_credentials WHERE id = ?').get(id) as PendingCredential | undefined;
}

export function updatePendingCredentialStatus(id: string, status: PendingCredentialStatus): void {
  getDb().prepare('UPDATE pending_credentials SET status = ? WHERE id = ?').run(status, id);
}

export function updatePendingCredentialMessageId(id: string, platformMessageId: string): void {
  getDb().prepare('UPDATE pending_credentials SET platform_message_id = ? WHERE id = ?').run(platformMessageId, id);
}

export function deletePendingCredential(id: string): void {
  getDb().prepare('DELETE FROM pending_credentials WHERE id = ?').run(id);
}
