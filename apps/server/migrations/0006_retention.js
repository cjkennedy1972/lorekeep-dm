import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(new URL('./0006_retention.sql', import.meta.url), 'utf8'),
  );
};
export const down = (pgm) => {
  pgm.sql(
    'DROP FUNCTION purge_session(uuid); DROP FUNCTION purge_expired_events(timestamptz); DROP TABLE retention_audit,legal_holds,retention_state;',
  );
};
