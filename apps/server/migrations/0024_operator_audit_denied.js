import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0024_operator_audit_denied.sql', import.meta.url),
      'utf8',
    ),
  );
export const down = (pgm) => {
  pgm.sql("DELETE FROM operator_endpoint_audit WHERE action = 'denied'");
  pgm.dropConstraint(
    'operator_endpoint_audit',
    'operator_endpoint_audit_slot_required_check',
  );
  pgm.dropConstraint(
    'operator_endpoint_audit',
    'operator_endpoint_audit_denied_reason_check',
  );
  pgm.dropConstraint(
    'operator_endpoint_audit',
    'operator_endpoint_audit_action_check',
  );
  pgm.dropColumn('operator_endpoint_audit', 'details');
  pgm.dropColumn('operator_endpoint_audit', 'reason');
  pgm.sql('ALTER TABLE operator_endpoint_audit ALTER COLUMN slot SET NOT NULL');
  pgm.addConstraint(
    'operator_endpoint_audit',
    'operator_endpoint_audit_action_check',
    {
      check: "action IN ('created','updated','deleted','tested')",
    },
  );
};
