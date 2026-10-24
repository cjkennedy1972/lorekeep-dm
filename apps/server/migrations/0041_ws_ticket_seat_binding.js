import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0041_ws_ticket_seat_binding.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) =>
  pgm.sql('ALTER TABLE ws_tickets DROP COLUMN seat_id;');
