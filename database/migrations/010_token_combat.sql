-- Persist token combat state (In Combat, Initiative, HP) and owner role for visibility gating.

ALTER TABLE tokens ADD COLUMN combat TEXT;
ALTER TABLE tokens ADD COLUMN owner_role TEXT;
