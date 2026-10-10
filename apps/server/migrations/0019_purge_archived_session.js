import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(
      new URL('./0019_purge_archived_session.sql', import.meta.url),
      'utf8',
    ),
  );
};
export const down = (pgm) => {
  pgm.sql('DROP FUNCTION purge_archived_session(uuid, timestamptz);');
};
