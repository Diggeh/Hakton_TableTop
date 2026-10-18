CREATE TABLE campaigns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE maps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  grid_size   INTEGER NOT NULL DEFAULT 70,
  width       INTEGER NOT NULL DEFAULT 2100,
  height      INTEGER NOT NULL DEFAULT 1400
);

CREATE TABLE tokens (
  id     TEXT    PRIMARY KEY,
  map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  label  TEXT    NOT NULL,
  x      REAL    NOT NULL DEFAULT 0,
  y      REAL    NOT NULL DEFAULT 0
);

CREATE INDEX idx_maps_campaign ON maps(campaign_id);
CREATE INDEX idx_tokens_map    ON tokens(map_id);
