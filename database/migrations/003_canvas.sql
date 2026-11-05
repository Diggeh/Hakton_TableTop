-- Virtual tabletop canvas: stored battle-map image and token ownership.

ALTER TABLE maps ADD COLUMN image_file TEXT;

ALTER TABLE tokens ADD COLUMN owner_id TEXT;
ALTER TABLE tokens ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN color TEXT;

CREATE INDEX IF NOT EXISTS idx_tokens_owner ON tokens(owner_id);
