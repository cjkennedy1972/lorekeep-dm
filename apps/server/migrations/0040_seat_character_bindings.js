import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0040_seat_character_bindings.sql', import.meta.url),
      'utf8',
    ),
  );

// Deliberately retain bindings and snapshots on rollback. ADR-035 requires a
// non-destructive rollback while compatible code drains or pauses active Rooms.
export const down = () => {};
