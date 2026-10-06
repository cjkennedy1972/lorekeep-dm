import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(
      new URL('./0005_ws_ticket_auth_session.sql', import.meta.url),
      'utf8',
    ),
  );
};
export const down = (pgm) => {
  pgm.sql('ALTER TABLE ws_tickets DROP COLUMN auth_token_hash;');
};
