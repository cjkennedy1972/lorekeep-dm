import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0042_allow_legacy_unbound_ws_tickets.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) =>
  pgm.sql(
    'DELETE FROM ws_tickets WHERE seat_id IS NULL; ALTER TABLE ws_tickets ALTER COLUMN seat_id SET NOT NULL;',
  );
