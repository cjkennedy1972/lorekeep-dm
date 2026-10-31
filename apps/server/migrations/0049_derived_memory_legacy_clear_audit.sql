CREATE TABLE IF NOT EXISTS derived_memory_legacy_clear_audit (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('dry_run','live')),
  code_version text NOT NULL,
  dry_run_id uuid REFERENCES derived_memory_legacy_clear_audit(run_id),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  outcome text NOT NULL CHECK (outcome IN ('running','dry_run_succeeded','live_succeeded','live_partial','aborted','failed')),
  approval_reference text NOT NULL DEFAULT 'Gmail INBOX uid 58 (2026-10-31 02:48:16 UTC): owner reconfirmation; permanent clear / no rebuild',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (mode <> 'dry_run' OR dry_run_id IS NULL),
  CHECK (mode <> 'live' OR dry_run_id IS NOT NULL OR outcome = 'aborted')
);
CREATE INDEX IF NOT EXISTS derived_memory_legacy_clear_recent_idx
  ON derived_memory_legacy_clear_audit (mode, code_version, finished_at DESC)
  WHERE outcome IN ('dry_run_succeeded','live_partial','live_succeeded');
