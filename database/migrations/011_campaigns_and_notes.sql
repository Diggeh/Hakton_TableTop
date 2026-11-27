-- Campaign metadata persistence, purge of preset/demo campaigns, and private per-user notebooks.

ALTER TABLE campaigns ADD COLUMN system TEXT NOT NULL DEFAULT 'D&D 5e';
ALTER TABLE campaigns ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN chapter TEXT NOT NULL DEFAULT 'Chapter I';
ALTER TABLE campaigns ADD COLUMN cover_photo TEXT;
ALTER TABLE campaigns ADD COLUMN sessions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN updated_at TEXT;

UPDATE campaigns
SET campaign_key = 'camp-' || id
WHERE campaign_key IS NULL;

UPDATE campaigns
SET updated_at = COALESCE(updated_at, created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Clear active_map_id references before removing legacy preset/seeded campaigns
-- so deleting rows never violates campaigns.active_map_id -> maps(id).
UPDATE campaigns
SET active_map_id = NULL
WHERE name IN ('First Campaign', 'The Sunken Coast', 'Ashes of the North');

DELETE FROM campaigns
WHERE name IN ('First Campaign', 'The Sunken Coast', 'Ashes of the North');

-- Private per-user folders and rich-text notes (scoped strictly by owner_id on device SQLite).
CREATE TABLE IF NOT EXISTS user_note_folders (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_note_folders_owner ON user_note_folders(owner_id);

CREATE TABLE IF NOT EXISTS user_notes (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  folder_id    TEXT REFERENCES user_note_folders(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_notes_owner  ON user_notes(owner_id);
CREATE INDEX IF NOT EXISTS idx_user_notes_folder ON user_notes(folder_id);
