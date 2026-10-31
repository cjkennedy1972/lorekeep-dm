import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(new URL('./0054_seat_streams.sql', import.meta.url), 'utf8'),
  );

export const down = (pgm) => pgm.dropTable('seat_streams');
