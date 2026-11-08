-- Continuous auto-save, session persistence, and recovery support.

-- Optimistic concurrency for autosaved documents. Every write increments the
-- revision; a client that sends a stale baseRevision gets the newest copy back
-- instead of silently overwriting someone else's edit.
ALTER TABLE characters ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dm_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

-- One recovery blueprint per campaign. The normalized maps/tokens tables stay
-- authoritative; this document is a server-generated snapshot used for late
-- joins, export, and disaster recovery.
CREATE TABLE IF NOT EXISTS board_documents (
  campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  data        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  revision    INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Persisted player identities so reconnects survive a host restart.
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  host_player_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS session_participants (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  display_name         TEXT NOT NULL,
  role                 TEXT NOT NULL,
  reconnect_token_hash TEXT NOT NULL,
  connected            INTEGER NOT NULL DEFAULT 0,
  joined_at            TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  left_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_participants_session
  ON session_participants(session_id);

-- Idempotency receipts for retried autosave commits. A reconnect flush or an
-- offline-queue replay must not apply the same edit twice.
CREATE TABLE IF NOT EXISTS autosave_receipts (
  save_id    TEXT PRIMARY KEY,
  response   TEXT NOT NULL CHECK (json_valid(response)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_autosave_receipts_created
  ON autosave_receipts(created_at);
