import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0025_account_content_boundaries.sql', import.meta.url),
      'utf8',
    ),
  );
export const down = (pgm) => {
  pgm.dropColumn('accounts', 'content_veils');
  pgm.dropColumn('accounts', 'content_lines');
};
