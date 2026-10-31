ALTER TABLE derived_memory_legacy_clear_audit
  ADD COLUMN IF NOT EXISTS backup_confirmed_at timestamptz;
