import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(new URL('./0001_game_core.sql', import.meta.url), 'utf8'),
  );
};
export const down = (pgm) => {
  pgm.sql(
    'DROP FUNCTION redact_event(uuid,bigint,jsonb); DROP TABLE session_lease,snapshots,events,sessions CASCADE; DROP FUNCTION block_event_mutation();',
  );
};
