import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0040_initialize_seat_resume_tokens.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) =>
  pgm.sql(
    `DROP TRIGGER events_initialize_seat_resume_token ON events;
     DROP FUNCTION initialize_seat_resume_token();
`,
  );
