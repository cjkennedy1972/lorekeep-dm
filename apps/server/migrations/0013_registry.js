import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(new URL('./0013_registry.sql', import.meta.url), 'utf8'),
  );
export const down = (pgm) =>
  pgm.sql('DROP TABLE registry_facts; DROP TABLE registry_entries;');
