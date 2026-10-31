CREATE TABLE IF NOT EXISTS derived_memory_reconcile_skipped (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  first_skipped_at timestamptz NOT NULL DEFAULT now(),
  checkpoint_row_kind text CHECK (checkpoint_row_kind IN ('scene_summary','registry_entry')),
  checkpoint_row_id bigint
);
