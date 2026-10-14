import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0030_scene_summary_turn_link.sql', import.meta.url),
      'utf8',
    ),
  );
export const down = (pgm) =>
  pgm.sql(
    'DROP INDEX scene_summaries_turn_idx; ALTER TABLE scene_summaries DROP COLUMN turn_id;',
  );
