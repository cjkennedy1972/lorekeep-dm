import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0035_ooc_chat_moderation.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) => {
  pgm.sql('DROP TABLE chat_mutes;');
  // Keep the widened checks: chat moderation rows are retained for 30 days,
  // and a rollback must not fail (or delete audit rows) while they exist.
};
