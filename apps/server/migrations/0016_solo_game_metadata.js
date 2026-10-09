import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0016_solo_game_metadata.sql', import.meta.url),
      'utf8',
    ),
  );
export const down = (pgm) =>
  pgm.sql(
    'DROP INDEX sessions_owner_activity_idx; ALTER TABLE sessions DROP COLUMN character, DROP COLUMN character_id, DROP COLUMN premise, DROP COLUMN catalog_version, DROP COLUMN difficulty, DROP COLUMN adventure_id, DROP COLUMN mode;',
  );
