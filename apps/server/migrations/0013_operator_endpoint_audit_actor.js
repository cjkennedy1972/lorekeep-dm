import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0013_operator_endpoint_audit_actor.sql', import.meta.url),
      'utf8',
    ),
  );
export const down = (pgm) => {
  pgm.dropConstraint(
    'operator_endpoint_audit',
    'operator_endpoint_audit_action_check',
  );
  pgm.dropColumn('operator_endpoint_audit', 'actor_id');
  pgm.addConstraint(
    'operator_endpoint_audit',
    'operator_endpoint_audit_action_check',
    {
      check: "action IN ('created','updated')",
    },
  );
};
