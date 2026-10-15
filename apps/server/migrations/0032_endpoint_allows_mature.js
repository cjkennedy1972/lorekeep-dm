import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(
      new URL('./0032_endpoint_allows_mature.sql', import.meta.url),
      'utf8',
    ),
  );
};
export const down = (pgm) => {
  pgm.sql('ALTER TABLE sessions DROP COLUMN endpoint_allows_mature;');
};
