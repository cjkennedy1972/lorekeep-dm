import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(new URL('./0022_host_tier_cap.sql', import.meta.url), 'utf8'),
  );
};
export const down = (pgm) => {
  pgm.sql('ALTER TABLE sessions DROP COLUMN host_tier_cap;');
};
