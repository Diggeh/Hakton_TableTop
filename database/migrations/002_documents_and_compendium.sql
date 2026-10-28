-- JSON document columns: flexible homebrew data, no migration per stat change.
-- CHECK(json_valid) guards against corrupt writes from any caller.

CREATE TABLE IF NOT EXISTS characters (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  name           TEXT NOT NULL,
  class_level    TEXT,
  sheet_data     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sheet_data)),
  inventory_data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(inventory_data)),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_characters_owner ON characters(owner_id);

CREATE TABLE IF NOT EXISTS dm_records (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL,
  title      TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dm_records_category ON dm_records(category);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  sender_id   TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  recipient_id TEXT,                       -- NULL = public; set = whisper
  type        TEXT NOT NULL,               -- 'text' | 'roll' | 'whisper' | 'system'
  payload     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_created   ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_recipient ON chat_messages(recipient_id);

CREATE TABLE IF NOT EXISTS compendium_entries (
  id       TEXT PRIMARY KEY,               -- implicit rowid is used by the FTS index
  source   TEXT NOT NULL,                  -- e.g. 'SRD', 'PHB', 'homebrew'
  category TEXT NOT NULL,                  -- 'spell' | 'monster' | 'rule' | ...
  name     TEXT NOT NULL,
  data     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))
);
CREATE INDEX IF NOT EXISTS idx_compendium_category ON compendium_entries(category);

-- External-content FTS5: index only, text stays in compendium_entries (no duplication).
CREATE VIRTUAL TABLE IF NOT EXISTS compendium_fts USING fts5(
  name, category, source,
  content='compendium_entries',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2',
  prefix='2 3'
);

CREATE TRIGGER IF NOT EXISTS compendium_ai AFTER INSERT ON compendium_entries BEGIN
  INSERT INTO compendium_fts(rowid, name, category, source)
  VALUES (new.rowid, new.name, new.category, new.source);
END;

CREATE TRIGGER IF NOT EXISTS compendium_ad AFTER DELETE ON compendium_entries BEGIN
  INSERT INTO compendium_fts(compendium_fts, rowid, name, category, source)
  VALUES ('delete', old.rowid, old.name, old.category, old.source);
END;

CREATE TRIGGER IF NOT EXISTS compendium_au AFTER UPDATE ON compendium_entries BEGIN
  INSERT INTO compendium_fts(compendium_fts, rowid, name, category, source)
  VALUES ('delete', old.rowid, old.name, old.category, old.source);
  INSERT INTO compendium_fts(rowid, name, category, source)
  VALUES (new.rowid, new.name, new.category, new.source);
END;
