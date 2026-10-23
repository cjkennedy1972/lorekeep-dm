import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0037_seat_resume_tokens.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) => pgm.sql('DROP TABLE seat_resume_tokens;');
