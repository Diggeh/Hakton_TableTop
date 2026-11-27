-- Track token asset category ('characters' | 'maps' | 'props' | 'attachments' | 'scenes')
-- and purge legacy seeded demo character sheets.

ALTER TABLE tokens ADD COLUMN category TEXT NOT NULL DEFAULT 'characters';
UPDATE tokens SET category = 'maps' WHERE is_map = 1;

DELETE FROM characters
WHERE id IN ('char-mira', 'char-thorne', 'char-ilyra')
  AND owner_id = 'demo-dm';
