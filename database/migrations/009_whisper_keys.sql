CREATE TABLE IF NOT EXISTS whisper_public_keys (
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  PRIMARY KEY (session_id, participant_id)
);
