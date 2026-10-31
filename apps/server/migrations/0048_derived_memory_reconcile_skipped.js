import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0048_derived_memory_reconcile_skipped.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = () => {};
