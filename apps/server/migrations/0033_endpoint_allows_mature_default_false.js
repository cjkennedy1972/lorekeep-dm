import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(
      new URL(
        './0033_endpoint_allows_mature_default_false.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
};
export const down = (pgm) => {
  pgm.sql(
    'ALTER TABLE sessions ALTER COLUMN endpoint_allows_mature SET DEFAULT true;',
  );
};
