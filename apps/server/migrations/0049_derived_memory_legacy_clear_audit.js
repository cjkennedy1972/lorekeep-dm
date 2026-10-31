import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0049_derived_memory_legacy_clear_audit.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = () => {};
