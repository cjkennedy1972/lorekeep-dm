ALTER TABLE retention_state
  ALTER COLUMN last_completed_at DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS deletions_blocked_by_coverage integer NOT NULL DEFAULT 0
  CHECK (deletions_blocked_by_coverage >= 0);
