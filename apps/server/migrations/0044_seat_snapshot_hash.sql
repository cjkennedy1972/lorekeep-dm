ALTER TABLE session_seat_characters
  ADD COLUMN IF NOT EXISTS character_snapshot_hash text;
