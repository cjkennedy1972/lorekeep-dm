import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0044_seat_snapshot_hash.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) =>
  pgm.sql(
    'ALTER TABLE session_seat_characters DROP COLUMN character_snapshot_hash;',
  );
