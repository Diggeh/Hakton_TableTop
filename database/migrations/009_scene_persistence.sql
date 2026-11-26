-- Per-campaign scene persistence, per-scene fog/wall state, and 35px default grid.

ALTER TABLE campaigns ADD COLUMN campaign_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_key
  ON campaigns(campaign_key)
  WHERE campaign_key IS NOT NULL;

ALTER TABLE maps ADD COLUMN scene_data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(scene_data));

-- Strip legacy seeded demo board tokens and starter-map preset background.
DELETE FROM tokens WHERE id IN ('tok-demo-1', 'tok-demo-2', 'tok-demo-3');
UPDATE maps SET image_file = NULL WHERE image_file LIKE '%starter-map.svg';

-- Replace legacy preset scene names with any placed scene token label or 'Untitled Scene'.
UPDATE maps
SET name = COALESCE(
  (
    SELECT label
    FROM tokens
    WHERE tokens.map_id = maps.id
      AND tokens.is_map = 1
    ORDER BY rowid DESC
    LIMIT 1
  ),
  'Untitled Scene'
)
WHERE name IN ('Drowned Sanctuary', 'Greyhaven Docks', 'The Old Lighthouse', 'Northwatch Crossing');

-- Migrate legacy 70px default grid cells to 35px.
UPDATE maps SET grid_size = 35 WHERE grid_size = 70;
