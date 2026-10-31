CREATE TABLE IF NOT EXISTS session_character_tokens (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  character_id uuid NOT NULL,
  token text NOT NULL,
  PRIMARY KEY (session_id, character_id),
  UNIQUE (session_id, token),
  CHECK (token ~ '^[A-Za-z0-9_-]{32,}$')
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
