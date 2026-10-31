import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0055_two_phase_seat_resume.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) =>
  pgm.sql(`DROP INDEX seat_resume_pending_expiry_idx;
    ALTER TABLE seat_resume_tokens
      DROP CONSTRAINT seat_resume_rotation_starts_cap,
      DROP CONSTRAINT seat_resume_rotation_window_pair,
      DROP CONSTRAINT seat_resume_last_activated_tuple,
      DROP CONSTRAINT seat_resume_pending_tuple,
      DROP COLUMN rotation_starts_in_window,
      DROP COLUMN rotation_window_started_at,
      DROP COLUMN last_activated_at,
      DROP COLUMN last_activated_socket_id,
      DROP COLUMN last_activated_rotation_id,
      DROP COLUMN pending_started_at,
      DROP COLUMN pending_expires_at,
      DROP COLUMN pending_socket_id,
      DROP COLUMN pending_rotation_id,
      DROP COLUMN pending_token_hash;`);
