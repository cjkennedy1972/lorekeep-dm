ALTER TABLE operator_endpoint_audit
  ALTER COLUMN slot DROP NOT NULL,
  ADD COLUMN reason text,
  ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb,
  DROP CONSTRAINT IF EXISTS operator_endpoint_audit_action_check,
  ADD CONSTRAINT operator_endpoint_audit_action_check
    CHECK (action IN ('created','updated','deleted','tested','denied')),
  ADD CONSTRAINT operator_endpoint_audit_denied_reason_check
    CHECK ((action = 'denied') = (reason IS NOT NULL)),
  ADD CONSTRAINT operator_endpoint_audit_slot_required_check
    CHECK (action = 'denied' OR slot IS NOT NULL);
COMMENT ON COLUMN operator_endpoint_audit.reason IS
  'Reason code for a denied or rejected attempt (action=denied); NULL for successful changes.';
COMMENT ON COLUMN operator_endpoint_audit.details IS
  'Non-secret detail: host, keyChanged and fingerprint for saves; method and route template for denials.';
