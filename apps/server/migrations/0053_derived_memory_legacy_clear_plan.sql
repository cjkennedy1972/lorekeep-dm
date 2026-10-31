CREATE TABLE derived_memory_legacy_clear_plan_runs (
  dry_run_id uuid PRIMARY KEY REFERENCES derived_memory_legacy_clear_audit(run_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE derived_memory_legacy_clear_plan (
  dry_run_id uuid NOT NULL REFERENCES derived_memory_legacy_clear_audit(run_id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  scene_summary_ids bigint[] NOT NULL DEFAULT '{}',
  registry_entry_ids bigint[] NOT NULL DEFAULT '{}',
  registry_fact_ids bigint[] NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done')),
  PRIMARY KEY (dry_run_id, session_id)
);

CREATE INDEX derived_memory_legacy_clear_plan_session_idx
  ON derived_memory_legacy_clear_plan (session_id);
