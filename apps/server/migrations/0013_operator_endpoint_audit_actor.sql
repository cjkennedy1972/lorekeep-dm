ALTER TABLE operator_endpoint_audit
  ADD COLUMN actor_id uuid;
COMMENT ON COLUMN operator_endpoint_audit.actor_id IS
  'Authenticated operator account UUID; legacy rows predate actor capture and remain NULL.';
ALTER TABLE operator_endpoint_audit
  DROP CONSTRAINT IF EXISTS operator_endpoint_audit_action_check;
ALTER TABLE operator_endpoint_audit
  ADD CONSTRAINT operator_endpoint_audit_action_check
  CHECK (action IN ('created','updated','deleted','tested'));
