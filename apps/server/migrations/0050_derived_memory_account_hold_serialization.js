import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL(
        './0050_derived_memory_account_hold_serialization.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );

export const down = () => {};
