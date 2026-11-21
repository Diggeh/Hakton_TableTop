-- Persist placed map graphics and dynamic token light/vision settings on tokens.

ALTER TABLE tokens ADD COLUMN is_map INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN image_url TEXT;
ALTER TABLE tokens ADD COLUMN width REAL;
ALTER TABLE tokens ADD COLUMN height REAL;
ALTER TABLE tokens ADD COLUMN light TEXT;
