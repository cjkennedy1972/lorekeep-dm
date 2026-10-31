ALTER TABLE derived_memory_legacy_clear_audit
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS reason_code text;
UPDATE derived_memory_legacy_clear_audit
   SET heartbeat_at=COALESCE(heartbeat_at,started_at)
 WHERE heartbeat_at IS NULL;
ALTER TABLE derived_memory_legacy_clear_audit
  ALTER COLUMN heartbeat_at SET DEFAULT now();
ALTER TABLE derived_memory_legacy_clear_audit
  ALTER COLUMN heartbeat_at SET NOT NULL;
