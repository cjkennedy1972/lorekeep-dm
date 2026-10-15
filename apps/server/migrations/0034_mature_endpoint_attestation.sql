ALTER TABLE sessions
  ADD COLUMN endpoint_mature_fingerprint text,
  ADD COLUMN moderation_mature_fingerprint text;

COMMENT ON COLUMN sessions.endpoint_mature_fingerprint IS
  'Fingerprint of the exact operator-configured solo-turn endpoint explicitly attested for mature use in this session.';

COMMENT ON COLUMN sessions.moderation_mature_fingerprint IS
  'Fingerprint of the exact operator-configured moderation endpoint explicitly attested for mature use in this session.';

ALTER TABLE operator_endpoint_audit
  DROP CONSTRAINT operator_endpoint_audit_action_check,
  ADD CONSTRAINT operator_endpoint_audit_action_check
    CHECK (action IN ('created','updated','deleted','tested','denied','mature_enabled','mature_disabled'));
