import { readFileSync } from 'node:fs';

export const up = (pgm) => {
  pgm.sql(
    readFileSync(new URL('./0003_lease_epoch.sql', import.meta.url), 'utf8'),
  );
};

export const down = (pgm) => {
  pgm.sql('ALTER TABLE session_lease DROP COLUMN epoch');
};
