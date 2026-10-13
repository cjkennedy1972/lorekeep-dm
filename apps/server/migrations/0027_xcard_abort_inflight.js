import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(
      new URL('./0027_xcard_abort_inflight.sql', import.meta.url),
      'utf8',
    ),
  );
};
export const down = (pgm) => {
  pgm.sql('ALTER TABLE sessions DROP COLUMN xcard_abort_inflight;');
};
