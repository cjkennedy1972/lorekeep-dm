import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0031_registry_turn_link.sql', import.meta.url),
      'utf8',
    ),
  );
export const down = (pgm) =>
  pgm.sql(
    'DROP INDEX registry_entries_turn_idx; ALTER TABLE registry_entries DROP COLUMN turn_id;',
  );
