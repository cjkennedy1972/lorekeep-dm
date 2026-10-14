ALTER TABLE scene_summaries ADD COLUMN turn_id text;
CREATE INDEX scene_summaries_turn_idx ON scene_summaries(session_id, turn_id);
