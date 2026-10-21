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
  pgm.sql(
    'ALTER TABLE moderation_log DROP CONSTRAINT moderation_log_source_check;',
  );
  pgm.sql(`ALTER TABLE moderation_log
    ADD CONSTRAINT moderation_log_source_check
    CHECK (source IN ('hardfloor','denylist','judge','failclosed'));`);
  pgm.sql(
    'ALTER TABLE moderation_log DROP CONSTRAINT moderation_log_surface_check;',
  );
  pgm.sql(`ALTER TABLE moderation_log
    ADD CONSTRAINT moderation_log_surface_check
    CHECK (surface IN ('player-action','clarification','character','table-name','room-name','display-name','report-reason'));`);
};
