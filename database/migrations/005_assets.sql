-- Asset catalog metadata for battle maps and character/token images.
-- Physical files live in <appData>/uploads/maps and <appData>/uploads/tokens;
-- only the relative UUID file_name is stored here so the DB remains portable.

CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  original_name TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('map', 'token')),
  category      TEXT NOT NULL DEFAULT 'maps' CHECK (category IN ('scenes', 'characters', 'maps', 'props', 'attachments')),
  file_name     TEXT NOT NULL UNIQUE,
  mime_type     TEXT NOT NULL,
  format        TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 262144000),
  width         INTEGER NOT NULL CHECK (width > 0),
  height        INTEGER NOT NULL CHECK (height > 0),
  campaign_id   INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  metadata      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_type       ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_category   ON assets(category);
CREATE INDEX IF NOT EXISTS idx_assets_campaign   ON assets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_assets_created_at ON assets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_name       ON assets(name COLLATE NOCASE);

ALTER TABLE maps ADD COLUMN asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
ALTER TABLE tokens ADD COLUMN asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
