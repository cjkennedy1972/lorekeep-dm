import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(new URL('./0004_room_invites.sql', import.meta.url), 'utf8'),
  );
};
export const down = (pgm) => {
  pgm.sql(
    'DROP INDEX sessions_invite_hash_key; ALTER TABLE sessions DROP COLUMN invite_hash, DROP COLUMN name;',
  );
};
