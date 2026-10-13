import { readFileSync } from 'node:fs';

export function up(pgm) {
  pgm.sql(
    readFileSync(
      new URL('./0026_moderation_boundary_failure.sql', import.meta.url),
      'utf8',
    ),
  );
}

export function down(pgm) {
  pgm.sql(
    "UPDATE moderation_log SET fail_closed_row='tier' WHERE fail_closed_row='boundaries';",
  );
  pgm.sql(
    "ALTER TABLE moderation_log ADD CONSTRAINT moderation_log_fail_closed_row_check CHECK (fail_closed_row IN ('hard-floor','tier'));",
  );
}
