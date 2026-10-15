-- Nullable provenance for registry versions so rewind can remove them. Existing rows stay NULL
-- (no backfill); rewind never removes NULL-provenance rows. Matches scene_summaries.turn_id (0030).
ALTER TABLE registry_entries ADD COLUMN turn_id text;
CREATE INDEX registry_entries_turn_idx ON registry_entries(session_id, turn_id) WHERE turn_id IS NOT NULL;
