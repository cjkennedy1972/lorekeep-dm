-- character_id intentionally has no account_characters FK: ON DELETE CASCADE would
-- erase identity links in held sessions. Character/account deletion cleans unheld links explicitly.
CREATE TABLE IF NOT EXISTS session_character_tokens (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  character_id uuid NOT NULL,
  token text NOT NULL,
  PRIMARY KEY (session_id, character_id),
  UNIQUE (session_id, token),
  CHECK (token ~ '^[A-Za-z0-9_-]{32}$')
);

CREATE TABLE IF NOT EXISTS derived_memory_character_refs (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  character_id uuid NOT NULL,
  row_kind text NOT NULL CHECK (row_kind IN ('scene_summary', 'registry_entry')),
  row_id bigint NOT NULL,
  PRIMARY KEY (session_id, character_id, row_kind, row_id)
);

CREATE INDEX IF NOT EXISTS derived_memory_character_refs_lookup_idx
  ON derived_memory_character_refs (session_id, character_id);
CREATE INDEX IF NOT EXISTS derived_memory_character_refs_row_idx
  ON derived_memory_character_refs (session_id, row_kind, row_id);

CREATE TABLE IF NOT EXISTS derived_memory_reconciliation_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  complete boolean NOT NULL DEFAULT false,
  checkpoint_session_id uuid,
  checkpoint_row_kind text CHECK (checkpoint_row_kind IN ('scene_summary','registry_entry')),
  checkpoint_row_id bigint
);
INSERT INTO derived_memory_reconciliation_state(singleton,complete) VALUES (true,false)
ON CONFLICT (singleton) DO NOTHING;

CREATE INDEX IF NOT EXISTS scene_summaries_reference_scan_idx ON scene_summaries(session_id,id);
CREATE INDEX IF NOT EXISTS registry_entries_reference_scan_idx ON registry_entries(session_id,id);
