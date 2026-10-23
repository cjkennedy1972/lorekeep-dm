import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0038_resume_socket_claim.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) =>
  pgm.sql(
    `DROP TRIGGER events_expire_seat_resume_token ON events;
     DROP FUNCTION expire_seat_resume_token_on_revocation();
     ALTER TABLE seat_resume_tokens DROP CONSTRAINT seat_resume_socket_heartbeat_pair, DROP COLUMN active_socket_id, DROP COLUMN heartbeat_at;`,
  );
