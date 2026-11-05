-- Shared tabletop state: persisted active scene + chat lookup indexes.

-- NULL means "fall back to the first map" so upgrades stay safe.
ALTER TABLE campaigns ADD COLUMN active_map_id INTEGER REFERENCES maps(id);

UPDATE campaigns
SET active_map_id = (
  SELECT id FROM maps WHERE maps.campaign_id = campaigns.id ORDER BY id LIMIT 1
)
WHERE active_map_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_sender ON chat_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_chat_created_id ON chat_messages(created_at, id);
