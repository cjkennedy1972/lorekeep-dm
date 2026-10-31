import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0053_derived_memory_legacy_clear_plan.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) =>
  pgm.sql(
    'DROP TABLE IF EXISTS derived_memory_legacy_clear_plan; DROP TABLE IF EXISTS derived_memory_legacy_clear_plan_runs;',
  );
