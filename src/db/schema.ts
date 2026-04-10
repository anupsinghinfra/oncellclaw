/**
 * Reference copy of the current v2 schema.
 * Read this to understand the DB structure.
 * Actual creation is done by migrations — do not use this at runtime.
 */

export const SCHEMA = `
-- Agent workspaces: folder, skills, CLAUDE.md, container config
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  is_admin         INTEGER DEFAULT 0,
  agent_provider   TEXT,
  container_config TEXT,
  created_at       TEXT NOT NULL
);

-- Platform groups/channels
CREATE TABLE messaging_groups (
  id               TEXT PRIMARY KEY,
  channel_type     TEXT NOT NULL,
  platform_id      TEXT NOT NULL,
  name             TEXT,
  is_group         INTEGER DEFAULT 0,
  admin_user_id    TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);

-- Which agent groups handle which messaging groups
CREATE TABLE messaging_group_agents (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  trigger_rules      TEXT,
  response_scope     TEXT DEFAULT 'all',
  session_mode       TEXT DEFAULT 'shared',
  priority           INTEGER DEFAULT 0,
  created_at         TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- Sessions: one folder = one session = one container when running
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

-- Pending interactive questions
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  created_at     TEXT NOT NULL
);
`;

/**
 * Session DB schemas — split into two files so each has exactly one writer.
 * This eliminates SQLite write contention across the host-container mount boundary.
 *
 *   inbound.db  — host writes, container reads (read-only mount or open read-only)
 *   outbound.db — container writes, host reads (read-only open)
 */

/** Host-owned: inbound messages + delivery tracking + destination map. */
export const INBOUND_SCHEMA = `
CREATE TABLE messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  tries          INTEGER DEFAULT 0,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);

-- Host tracks delivery outcomes for messages_out IDs.
-- Avoids writing to outbound.db (container-owned).
CREATE TABLE delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

-- Destination map for this session's agent.
-- Host overwrites on every container wake AND on demand (admin rewires, new child agents, etc.).
-- Container queries this live on every lookup, so admin changes take effect
-- mid-session without requiring a container restart.
CREATE TABLE destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type    TEXT,            -- for type='channel'
  platform_id     TEXT,            -- for type='channel'
  agent_group_id  TEXT             -- for type='agent'
);
`;

/** Container-owned: outbound messages + processing acknowledgments. */
export const OUTBOUND_SCHEMA = `
CREATE TABLE messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);

-- Container tracks processing status here instead of updating messages_in.
-- Host reads this to know which messages have been processed.
-- On container startup, stale 'processing' entries are cleared (crash recovery).
CREATE TABLE processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);
`;
